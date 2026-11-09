import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AuthRequiredError,
  CalendarApiError,
  SCOPES,
  createAuth,
  createCalendarClient,
  describeError,
  hasAllScopes
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


function setupAuth() {
  const state = { time: 1000, events: [], timers: [], requested: 0 };
  const oauth2 = {
    initTokenClient(config) {
      state.config = config;
      return { requestAccessToken() { state.requested++; } };
    }
  };
  const auth = createAuth({
    clientId: 'fake-client',
    oauth2,
    onChange: event => state.events.push(event),
    now: () => state.time,
    setTimer: (fn, ms) => { state.timers.push({ fn, ms }); return state.timers.length; },
    clearTimer: () => {}
  });

  return { auth, state };
}

const grant = { access_token: 'tok', expires_in: 3600, scope: SCOPES.join(' ') };


test('ログイン成功でトークンを保持し、期限が近づくと expired を通知する', () => {
  const { auth, state } = setupAuth();

  assert.equal(state.config.client_id, 'fake-client');
  assert.equal(state.config.scope, SCOPES.join(' '));
  assert.equal(auth.getAccessToken(), null);

  auth.signIn();
  assert.equal(state.requested, 1);

  state.config.callback(grant);
  assert.deepEqual(state.events, [{ state: 'signedIn' }]);
  assert.equal(auth.getAccessToken(), 'tok');
  assert.equal(state.timers[0].ms, 3570 * 1000);

  state.time += 3570 * 1000;
  assert.equal(auth.getAccessToken(), null);
  assert.deepEqual(state.events.at(-1), { state: 'expired' });

  // 2回目は通知しない
  auth.invalidate();
  state.timers[0].fn();
  assert.equal(state.events.length, 2);
});


test('一部のスコープだけ許可されたらトークンを保持しない', () => {
  const { auth, state } = setupAuth();

  state.config.callback({ ...grant, scope: SCOPES[0] });

  assert.deepEqual(state.events, [{ state: 'partial' }]);
  assert.equal(auth.getAccessToken(), null);
});


test('同意の拒否とポップアップの失敗を通知する', () => {
  const { auth, state } = setupAuth();

  state.config.callback({ error: 'access_denied' });
  state.config.error_callback({ type: 'popup_closed' });

  assert.deepEqual(state.events, [
    { state: 'error', code: 'access_denied' },
    { state: 'error', code: 'popup_closed' }
  ]);
  assert.equal(auth.getAccessToken(), null);
});
