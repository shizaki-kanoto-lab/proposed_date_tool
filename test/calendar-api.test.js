import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AuthRequiredError,
  CalendarApiError,
  SCOPES,
  buildAuthUrl,
  createAuth,
  createCalendarClient,
  describeError,
  getRedirectUri,
  hasAllScopes,
  parseAuthResponse
} from '../web/calendar-api.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const apiError = (status, reason, message = '架空のエラー') =>
  json({ error: { message, errors: [{ reason }] } }, status);

function fakeAuth(token = 'fake-token') {
  return {
    invalidated: 0,
    getAccessToken() { return this.invalidated ? null : token; },
    invalidate() { this.invalidated++; }
  };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    return handler(parsed, calls.length);
  };
  impl.calls = calls;
  return impl;
}

const client = (fetchImpl, auth = fakeAuth()) =>
  createCalendarClient({ auth, fetchImpl, sleep: async () => {} });

const RANGE = ['2026-12-01T00:00:00.000Z', '2026-12-02T00:00:00.000Z'];


test('スコープは読み取り専用の2つだけ', () => {
  assert.deepEqual(SCOPES, [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events.owned.readonly'
  ]);
  assert.equal(hasAllScopes(SCOPES.join(' ')), true);
  assert.equal(hasAllScopes(SCOPES[0]), false);
  assert.equal(hasAllScopes(undefined), false);
});


test('listOwnedCalendars は owner 指定でページ送りする', async () => {
  const fetchImpl = fakeFetch(url =>
    url.searchParams.get('pageToken') === 'p2'
      ? json({ items: [{ id: 'person@example.com', summary: 'B', primary: true }] })
      : json({ items: [{ id: 'a', summary: 'A' }], nextPageToken: 'p2' })
  );

  const result = await client(fetchImpl).listOwnedCalendars();

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].url.pathname, '/calendar/v3/users/me/calendarList');
  assert.equal(fetchImpl.calls[0].url.searchParams.get('minAccessRole'), 'owner');
  assert.equal(fetchImpl.calls[0].url.searchParams.get('showHidden'), 'true');
  assert.equal(fetchImpl.calls[0].options.headers.Authorization, 'Bearer fake-token');
  assert.deepEqual(result.calendars.map(item => item.id), ['a', 'person@example.com']);
  assert.equal(result.primaryEmail, 'person@example.com');
});


test('fetchEvents は期間全体を singleEvents でページ送りし、IDをエンコードする', async () => {
  const fetchImpl = fakeFetch(url =>
    url.searchParams.get('pageToken')
      ? json({ items: [{ summary: '2件目', start: { date: '2026-12-02' }, end: { date: '2026-12-03' } }] })
      : json({
          items: [{ summary: '1件目', start: { date: '2026-12-01' }, end: { date: '2026-12-02' } }],
          nextPageToken: 'next'
        })
  );

  const { succeeded, failed } = await client(fetchImpl)
    .fetchEvents([{ id: 'a#b@example.com', name: 'A' }], ...RANGE);

  const first = fetchImpl.calls[0].url;

  assert.equal(first.pathname, '/calendar/v3/calendars/a%23b%40example.com/events');
  assert.equal(first.searchParams.get('singleEvents'), 'true');
  assert.equal(first.searchParams.get('timeMin'), RANGE[0]);
  assert.equal(first.searchParams.get('timeMax'), RANGE[1]);
  assert.equal(fetchImpl.calls[1].url.searchParams.get('pageToken'), 'next');
  assert.deepEqual(failed, []);
  assert.deepEqual(succeeded[0].events.map(event => event.title), ['1件目', '2件目']);
});


test('カレンダー1つの失敗では止めず failed に入れる', async () => {
  const fetchImpl = fakeFetch(url =>
    url.pathname.includes('/bad/')
      ? apiError(403, 'forbidden')
      : json({ items: [] })
  );

  const { succeeded, failed } = await client(fetchImpl).fetchEvents(
    [{ id: 'good', name: '良' }, { id: 'bad', name: '悪' }],
    ...RANGE
  );

  assert.deepEqual(succeeded.map(item => item.id), ['good']);
  assert.deepEqual(failed.map(item => item.id), ['bad']);
  assert.ok(failed[0].error instanceof CalendarApiError);
});


test('401 はトークンを破棄して全体を止める', async () => {
  const auth = fakeAuth();
  const fetchImpl = fakeFetch(url =>
    url.pathname.includes('/expired/') ? json({}, 401) : json({ items: [] })
  );

  await assert.rejects(
    client(fetchImpl, auth).fetchEvents(
      [{ id: 'good', name: '良' }, { id: 'expired', name: '切' }],
      ...RANGE
    ),
    AuthRequiredError
  );
  assert.equal(auth.invalidated, 1);
});


test('トークンがなければ通信せず止める', async () => {
  const auth = fakeAuth();
  auth.invalidated = 1;
  const fetchImpl = fakeFetch(() => json({ items: [] }));

  await assert.rejects(client(fetchImpl, auth).listOwnedCalendars(), AuthRequiredError);
  assert.equal(fetchImpl.calls.length, 0);
});


test('レート制限と一時的な障害は再試行し、権限エラーは再試行しない', async () => {
  const limited = fakeFetch((url, count) =>
    count === 1 ? apiError(403, 'rateLimitExceeded')
      : count === 2 ? json({}, 503)
      : json({ items: [] })
  );

  await client(limited).listOwnedCalendars();
  assert.equal(limited.calls.length, 3);

  const forbidden = fakeFetch(() => apiError(403, 'forbidden'));

  await assert.rejects(client(forbidden).listOwnedCalendars(), CalendarApiError);
  assert.equal(forbidden.calls.length, 1);

  const down = fakeFetch(() => json({}, 503));

  await assert.rejects(client(down).listOwnedCalendars(), CalendarApiError);
  assert.equal(down.calls.length, 3);
});


test('describeError の文言', () => {
  assert.equal(
    describeError(new CalendarApiError(403, 'accessNotConfigured', 'x')),
    'Google Calendar API が有効になっていません。'
  );
  assert.equal(
    describeError(new CalendarApiError(403, 'forbidden', '架空')),
    '読み取る権限がありません。（架空）'
  );
  assert.equal(
    describeError(new TypeError('Failed to fetch')),
    '通信に失敗しました。接続を確認してもう一度お試しください。'
  );
});


function fakeStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    map
  };
}

function setupAuth({ storage = fakeStorage() } = {}) {
  const state = { time: 1000, events: [], timers: [], navigated: [] };
  let counter = 0;
  const auth = createAuth({
    clientId: 'fake-client',
    redirectUri: 'https://example.test/tool/',
    storage,
    navigate: url => state.navigated.push(new URL(url)),
    onChange: event => state.events.push(event),
    cryptoImpl: { getRandomValues: bytes => bytes.fill(++counter) },
    now: () => state.time,
    setTimer: (fn, ms) => { state.timers.push({ fn, ms }); return state.timers.length; },
    clearTimer: () => {}
  });

  return { auth, state, storage };
}

// signIn で移動した先の state を使って、Google から戻ってきた URL の # を作る
function returnHash(state, fields) {
  const sent = state.navigated.at(-1).searchParams.get('state');
  return '#' + new URLSearchParams({ state: sent, ...fields });
}

const grant = { access_token: 'tok', token_type: 'Bearer', expires_in: '3600', scope: SCOPES.join(' ') };


test('同意画面の URL は読み取り専用の2スコープで、トークンを # で受け取る', () => {
  const url = new URL(buildAuthUrl({
    clientId: 'fake-client',
    redirectUri: 'https://example.test/tool/',
    state: 'abc'
  }));

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'fake-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.test/tool/');
  assert.equal(url.searchParams.get('response_type'), 'token');
  assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(url.searchParams.get('state'), 'abc');
});


test('戻り先は index.html の有無にかかわらず同じ', () => {
  assert.equal(
    getRedirectUri({ origin: 'https://example.test', pathname: '/tool/index.html' }),
    'https://example.test/tool/'
  );
  assert.equal(
    getRedirectUri({ origin: 'https://example.test', pathname: '/tool/' }),
    'https://example.test/tool/'
  );
});


test('ログインの応答でない # は無視する', () => {
  assert.equal(parseAuthResponse(''), null);
  assert.equal(parseAuthResponse('#section'), null);
  assert.deepEqual(parseAuthResponse('#error=access_denied&state=x'), { error: 'access_denied', state: 'x' });
});


test('ログイン成功でトークンを保持し、期限が近づくと expired を通知する', () => {
  const { auth, state, storage } = setupAuth();

  assert.equal(auth.getAccessToken(), null);
  assert.equal(auth.completeSignIn(''), false);

  auth.signIn();
  assert.equal(state.navigated.length, 1);
  assert.equal(state.navigated[0].searchParams.get('client_id'), 'fake-client');
  assert.equal(storage.map.size, 1);

  assert.equal(auth.completeSignIn(returnHash(state, grant)), true);
  assert.deepEqual(state.events, [{ state: 'signedIn' }]);
  assert.equal(auth.getAccessToken(), 'tok');
  assert.equal(state.timers[0].ms, 3570 * 1000);
  assert.equal(storage.map.size, 0, 'state は使い捨て');

  state.time += 3570 * 1000;
  assert.equal(auth.getAccessToken(), null);
  assert.deepEqual(state.events.at(-1), { state: 'expired' });

  // 2回目は通知しない
  auth.invalidate();
  state.timers[0].fn();
  assert.equal(state.events.length, 2);
});


test('state が一致しない応答は受け付けない', () => {
  const { auth, state } = setupAuth();

  // ログインを始めていないのに応答が来た
  assert.equal(auth.completeSignIn('#' + new URLSearchParams({ ...grant, state: 'forged' })), true);

  // 始めたが state が違う
  auth.signIn();
  auth.completeSignIn('#' + new URLSearchParams({ ...grant, state: 'forged' }));

  assert.deepEqual(state.events, [
    { state: 'error', code: 'state_mismatch' },
    { state: 'error', code: 'state_mismatch' }
  ]);
  assert.equal(auth.getAccessToken(), null);
});


test('一部のスコープだけ許可されたらトークンを保持しない', () => {
  const { auth, state } = setupAuth();

  auth.signIn();
  auth.completeSignIn(returnHash(state, { ...grant, scope: SCOPES[0] }));

  assert.deepEqual(state.events, [{ state: 'partial' }]);
  assert.equal(auth.getAccessToken(), null);
});


test('同意の拒否を通知する', () => {
  const { auth, state } = setupAuth();

  auth.signIn();
  auth.completeSignIn(returnHash(state, { error: 'access_denied' }));

  assert.deepEqual(state.events, [{ state: 'error', code: 'access_denied' }]);
  assert.equal(auth.getAccessToken(), null);
});


test('保存領域が使えなければ移動せずにエラーを通知する', () => {
  const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() {} };
  const { auth, state } = setupAuth({ storage: broken });

  auth.signIn();

  assert.equal(state.navigated.length, 0);
  assert.deepEqual(state.events, [{ state: 'error', code: 'storage_unavailable' }]);
});
