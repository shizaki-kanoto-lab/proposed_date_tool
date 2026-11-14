/**
 * Googleログイン（OAuth 2.0 のブラウザ向けフロー。ページごと Google へ移動して戻る）と
 * Calendar API の取得。
 *
 * アクセストークンはメモリにのみ保持し、ブラウザの保存領域には書き込まない。
 * 保存領域に置くのは、戻ってきた応答を照合するための使い捨ての state だけ。
 */

import { normalizeApiEvents, normalizeCalendarList } from './core.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const STATE_KEY = 'oauthState';
const API_BASE = 'https://www.googleapis.com/calendar/v3';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.owned.readonly'
];

// 期限ちょうどに通信が失敗しないよう、少し早めに期限切れとして扱う
const TOKEN_EXPIRY_MARGIN_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const RETRY_DELAYS_MS = [500, 1500];
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);


/** ログインし直さないと続けられないときのエラー */
export class AuthRequiredError extends Error {
  constructor() {
    super('ログインが必要です。');
    this.name = 'AuthRequiredError';
  }
}


export class CalendarApiError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = 'CalendarApiError';
    this.status = status;
    this.reason = reason;
  }
}


/* ==========================================
 * ログイン
 * ========================================== */

/**
 * 同意画面で一部のスコープだけが許可された場合に false を返す。
 */
export function hasAllScopes(grantedScope) {
  const granted = new Set(String(grantedScope || '').split(/\s+/));

  return SCOPES.every(scope => granted.has(scope));
}


/**
 * 戻り先の URL。index.html 付きで開かれても、登録した URI と一致させる。
 */
export function getRedirectUri(loc) {
  return loc.origin + loc.pathname.replace(/index\.html$/, '');
}


/**
 * Google の同意画面の URL。
 */
export function buildAuthUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: SCOPES.join(' '),
    include_granted_scopes: 'false',
    prompt: 'select_account',
    state
  });

  return `${AUTH_ENDPOINT}?${params}`;
}


/**
 * 戻ってきた URL の # 以降を読む。ログインの応答でなければ null。
 */
export function parseAuthResponse(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));

  if (!params.has('access_token') && !params.has('error')) {
    return null;
  }

  return Object.fromEntries(params);
}


function randomState(cryptoImpl) {
  const bytes = new Uint8Array(16);

  cryptoImpl.getRandomValues(bytes);

  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}


/**
 * onChange には次のいずれかが渡される。
 *   { state: 'signedIn' }
 *   { state: 'expired' }          期限切れ、または 401
 *   { state: 'partial' }          一部のスコープが拒否された
 *   { state: 'error', code }      同意の拒否や、応答の照合の失敗
 *
 * storage にはタブを閉じると消えるセッション用の保存領域を渡す。state の照合にだけ使う。
 */
export function createAuth({
  clientId,
  redirectUri,
  storage,
  navigate,
  onChange,
  cryptoImpl = globalThis.crypto,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let token = null;
  let expiresAt = 0;
  let timer = null;

  function clear() {
    token = null;
    expiresAt = 0;

    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function expire() {
    if (!token) {
      return;
    }

    clear();
    onChange({ state: 'expired' });
  }

  function takeSavedState() {
    let saved = null;

    try {
      saved = storage.getItem(STATE_KEY);
      storage.removeItem(STATE_KEY);
    } catch {
      saved = null;
    }

    return saved;
  }

  return {
    /** 同じタブで Google の同意画面へ移動する */
    signIn() {
      const state = randomState(cryptoImpl);

      try {
        storage.setItem(STATE_KEY, state);
      } catch {
        onChange({ state: 'error', code: 'storage_unavailable' });
        return;
      }

      navigate(buildAuthUrl({ clientId, redirectUri, state }));
    },

    /**
     * 戻ってきた URL の # 以降を処理する。ログインの応答だったら true。
     * 呼び出し側は、true のとき URL から # 以降を消すこと。
     */
    completeSignIn(hash) {
      const response = parseAuthResponse(hash);

      if (!response) {
        return false;
      }

      clear();

      const saved = takeSavedState();

      if (!saved || response.state !== saved) {
        onChange({ state: 'error', code: 'state_mismatch' });
        return true;
      }

      if (response.error) {
        onChange({ state: 'error', code: response.error });
        return true;
      }

      if (!hasAllScopes(response.scope)) {
        onChange({ state: 'partial' });
        return true;
      }

      const lifetimeMs = Number(response.expires_in) * 1000;

      token = response.access_token;
      expiresAt = now() + lifetimeMs;
      timer = setTimer(expire, Math.max(lifetimeMs - TOKEN_EXPIRY_MARGIN_MS, 0));

      onChange({ state: 'signedIn' });
      return true;
    },

    /** 有効なトークン。なければ null */
    getAccessToken() {
      if (token && now() >= expiresAt - TOKEN_EXPIRY_MARGIN_MS) {
        expire();
      }

      return token;
    },

    invalidate: expire
  };
}

/* ==========================================
 * Calendar API
 * ========================================== */

async function toApiError(response) {
  let reason = '';
  let message = '';

  try {
    const body = await response.json();

    reason = body.error?.errors?.[0]?.reason || body.error?.status || '';
    message = body.error?.message || '';
  } catch (error) {
    // 本文がJSONでない応答はステータスだけで扱う
  }

  return new CalendarApiError(
    response.status,
    reason,
    message || `HTTP ${response.status}`
  );
}


function isRetryable(error) {
  return RETRYABLE_STATUS.has(error.status) ||
    (error.status === 403 && RATE_LIMIT_REASONS.has(error.reason));
}


export function createCalendarClient({
  auth,
  fetchImpl = (...args) => fetch(...args),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  async function getJson(path, params) {
    const url = `${API_BASE}${path}?${new URLSearchParams(params)}`;

    for (let attempt = 0; ; attempt++) {
      const token = auth.getAccessToken();

      if (!token) {
        throw new AuthRequiredError();
      }

      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (response.ok) {
        return response.json();
      }

      if (response.status === 401) {
        auth.invalidate();
        throw new AuthRequiredError();
      }

      const error = await toApiError(response);

      if (attempt >= RETRY_DELAYS_MS.length || !isRetryable(error)) {
        throw error;
      }

      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  async function getAllItems(path, params) {
    const items = [];
    let pageToken = null;

    do {
      const page = await getJson(
        path,
        pageToken ? { ...params, pageToken } : params
      );

      items.push(...(page.items || []));
      pageToken = page.nextPageToken || null;
    } while (pageToken);

    return items;
  }

  return {
    /**
     * getOwnedCalendars の置き換え。
     * CalendarApp は非表示のカレンダーも返すので showHidden を付ける。
     */
    async listOwnedCalendars() {
      const items = await getAllItems('/users/me/calendarList', {
        minAccessRole: 'owner',
        showHidden: 'true',
        maxResults: '250',
        fields: 'nextPageToken,items(id,summary,summaryOverride,primary)'
      });

      return normalizeCalendarList(items);
    },

    /**
     * カレンダーごとに期間全体を一括取得する。
     * 1つ失敗しても残りは続けるが、ログイン切れだけは全体を止める。
     */
    async fetchEvents(calendars, timeMin, timeMax) {
      const settled = await Promise.allSettled(
        calendars.map(calendar =>
          getAllItems(`/calendars/${encodeURIComponent(calendar.id)}/events`, {
            singleEvents: 'true',
            timeMin,
            timeMax,
            maxResults: '2500',
            fields:
              'nextPageToken,items(status,summary,start,end,eventType,' +
              'transparency,attendees(self,responseStatus))'
          })
        )
      );

      const succeeded = [];
      const failed = [];

      settled.forEach((result, index) => {
        const calendar = calendars[index];

        if (result.status === 'fulfilled') {
          succeeded.push({ ...calendar, events: normalizeApiEvents(result.value) });
        } else if (result.reason instanceof AuthRequiredError) {
          throw result.reason;
        } else {
          failed.push({ ...calendar, error: result.reason });
        }
      });

      return { succeeded, failed };
    }
  };
}


/**
 * 画面に出すエラー文。
 */
export function describeError(error) {
  if (error instanceof CalendarApiError) {
    if (error.reason === 'accessNotConfigured') {
      return 'Google Calendar API が有効になっていません。';
    }

    if (error.status === 403 && !RATE_LIMIT_REASONS.has(error.reason)) {
      return `読み取る権限がありません。（${error.message}）`;
    }

    return `Google Calendar API のエラーです。（${error.status}: ${error.message}）`;
  }

  if (error && (error.name === 'TimeoutError' || error.name === 'TypeError')) {
    return '通信に失敗しました。接続を確認してもう一度お試しください。';
  }

  return (error && error.message) || String(error);
}
