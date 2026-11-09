/**
 * 空き日程抽出ツール（GitHub Pages版）の画面処理。
 *
 * GAS版 index.html のスクリプトを移したもの。サーバー呼び出しを
 * calendar-api.js と core.js に置き換え、CSP のためインラインのイベント属性をやめている。
 */

import {
  AuthRequiredError,
  createAuth,
  createCalendarClient,
  describeError,
  loadGoogleIdentity
} from './calendar-api.js';
import { GOOGLE_CLIENT_ID } from './config.js';
import {
  getDayDebug,
  getFetchRange,
  getProposedDates,
  selectTargetCalendars,
  validateSearchParams
} from './core.js';


/* ==========================================
 * 画面上へのエラー表示(不具合調査用)
 * ========================================== */

window.addEventListener(
  'error',
  function(event) {

    const status =
      document.getElementById(
        'status'
      );


    if (status) {

      status.innerHTML +=
        '<div class="error">' +
        '画面エラー：' +
        escapeHtml(
          event.message ||
          event.error ||
          event
        ) +
        '</div>';
    }
  }
);


/* ==========================================
 * 直近の検索結果(出力形式の再生成用)
 * ========================================== */

let lastResultDates = [];


/* ------------------------------------------
 * ログインと取得済みデータ（メモリのみ）
 * ------------------------------------------ */

const EMAIL_TIMEOUT_MS = 8000;

let auth = null;
let calendarClient = null;

// 所有カレンダーの一覧。未取得なら null
let ownedCalendars = null;

// 直近の検索で取得した予定。getDayDebug はこれを使う
let lastFetch = null;

let lastEmail = null;
let searchSequence = 0;


/* ==========================================
 * 初期化
 * ========================================== */

window.addEventListener(
  'load',
  initialize
);


function reportInitError_(
  label,
  error
) {

  console.log(
    label,
    error
  );


  const status =
    document.getElementById(
      'status'
    );


  if (status) {

    status.innerHTML +=
      '<div class="error">' +
      escapeHtml(label) +
      '：' +
      escapeHtml(
        (error && error.message) ||
        error
      ) +
      '</div>';
  }
}


function initialize() {

  try {

    bindEvents();

  } catch (error) {

    reportInitError_(
      '画面の初期化に失敗しました。',
      error
    );
  }


  try {

    createTimeOptions();

  } catch (error) {

    reportInitError_(
      '時間選択肢の作成に失敗しました。',
      error
    );
  }


  try {

    const today =
      new Date();


    const firstDay =
      new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate()
      );


    const lastDay =
      new Date(
        today.getFullYear(),
        today.getMonth() + 2,
        0
      );


    document.getElementById(
      'startDate'
    ).value =
      formatInputDate(
        firstDay
      );


    document.getElementById(
      'endDate'
    ).value =
      formatInputDate(
        lastDay
      );

  } catch (error) {

    reportInitError_(
      '日付初期値の設定に失敗しました。',
      error
    );
  }


  try {

    loadSettings();

  } catch (error) {

    reportInitError_(
      '設定の読み込みに失敗しました。',
      error
    );
  }


  initializeAuth();
}


/* ==========================================
 * イベント登録
 * ========================================== */

function bindEvents() {

  const clicks = {
    loginButton: signIn,
    searchButton: searchDates,
    copyButton: copyResult,
    clearButton: clearResult,
    checkAllButton: checkAllCalendars,
    uncheckAllButton: uncheckAllCalendars
  };


  Object.keys(clicks).forEach(
    id => {

      document
        .getElementById(id)
        .addEventListener(
          'click',
          clicks[id]
        );
    }
  );


  ['zeroPad', 'monthDayOnly', 'includeTime'].forEach(
    id => {

      document
        .getElementById(id)
        .addEventListener(
          'change',
          refreshOutputText
        );
    }
  );


  document
    .getElementById('debugEnabled')
    .addEventListener(
      'change',
      toggleDebug
    );


  document
    .getElementById('debugArea')
    .addEventListener(
      'click',
      function(event) {

        const button =
          event.target.closest(
            '.debug-detail-button'
          );


        if (button) {

          loadDebug(
            button.dataset.date,
            button.dataset.index
          );
        }
      }
    );
}


/* ==========================================
 * ログイン
 * ========================================== */

async function initializeAuth() {

  if (!GOOGLE_CLIENT_ID) {

    showStatus(
      'error',
      'OAuthクライアントIDが設定されていません。web/config.js を確認してください。'
    );

    return;
  }


  try {

    const oauth2 =
      await loadGoogleIdentity();


    auth =
      createAuth({
        clientId: GOOGLE_CLIENT_ID,
        oauth2: oauth2,
        onChange: handleAuthChange
      });


    calendarClient =
      createCalendarClient({
        auth: auth
      });


    document.getElementById(
      'loginButton'
    ).disabled = false;

  } catch (error) {

    showStatus(
      'error',
      error.message +
      ' 広告ブロッカーなどが読み込みを止めていないか確認してください。'
    );
  }
}


/*
 * ポップアップがブロックされないよう、
 * クリックの処理の中から同期的に開く。
 */
function signIn() {

  if (auth) {

    auth.signIn();
  }
}


function handleAuthChange(
  change
) {

  if (change.state === 'signedIn') {

    document.getElementById(
      'loginButton'
    ).hidden = true;


    showStatus(
      '',
      ''
    );


    loadCalendars();

    return;
  }


  document.getElementById(
    'loginButton'
  ).hidden = false;


  document.getElementById(
    'currentUserEmail'
  ).textContent =
    '未ログイン';


  if (change.state === 'expired') {

    showStatus(
      'warning',
      'ログインの有効期限が切れました。もう一度ログインしてください。'
    );

  } else if (change.state === 'partial') {

    showStatus(
      'error',
      '一部の権限が許可されなかったため利用できません。' +
      '「カレンダーの一覧」と「所有するカレンダーの予定」の両方にチェックを入れて、もう一度ログインしてください。'
    );

  } else {

    showStatus(
      'error',
      getAuthErrorMessage(
        change.code
      )
    );
  }
}


function getAuthErrorMessage(
  code
) {

  if (code === 'popup_closed') {

    return 'ログインが完了する前に画面が閉じられました。もう一度お試しください。';
  }


  if (code === 'popup_failed_to_open') {

    return 'ログイン画面を開けませんでした。ポップアップのブロックを解除してください。';
  }


  if (code === 'access_denied') {

    return 'カレンダーへのアクセスが許可されませんでした。';
  }


  return `ログインに失敗しました。（${code}）`;
}


/* ==========================================
 * 状態表示
 * ========================================== */

function showStatus(
  type,
  message
) {

  document.getElementById(
    'status'
  ).innerHTML =
    message
      ? `<div class="${type}">${escapeHtml(message)}</div>`
      : '';
}


/* ==========================================
 * 時間選択肢作成
 * ========================================== */

function createTimeOptions() {

  const ids = [
    'dayStart',
    'dayEnd',
    'nightStart',
    'nightEnd'
  ];


  ids.forEach(
    id => {

      const select =
        document.getElementById(id);


      select.innerHTML = '';


      /*
       * 00:00〜23:30
       */
      for (
        let hour = 0;
        hour < 24;
        hour++
      ) {

        for (
          let minute = 0;
          minute < 60;
          minute += 30
        ) {

          const value =
            `${String(hour).padStart(2, '0')}:` +
            `${String(minute).padStart(2, '0')}`;


          const option =
            document.createElement(
              'option'
            );


          option.value =
            value;

          option.textContent =
            value;


          select.appendChild(
            option
          );
        }
      }


      /*
       * 24:00
       */
      const option24 =
        document.createElement(
          'option'
        );


      option24.value =
        '24:00';

      option24.textContent =
        '24:00';


      select.appendChild(
        option24
      );
    }
  );


  /*
   * 初期値
   */
  document.getElementById(
    'dayStart'
  ).value = '13:00';


  document.getElementById(
    'dayEnd'
  ).value = '18:00';


  document.getElementById(
    'nightStart'
  ).value = '21:00';


  /*
   * 夜の終了は24:00
   */
  document.getElementById(
    'nightEnd'
  ).value = '24:00';
}


/* ==========================================
 * 設定読み込み
 * ========================================== */

function loadSettings() {

  const saved =
    localStorage.getItem(
      'proposedDateSettings'
    );


  if (!saved) {
    return;
  }


  try {

    const settings =
      JSON.parse(saved);


    setSelectValue(
      'dayStart',
      settings.dayStart
    );


    setSelectValue(
      'dayEnd',
      settings.dayEnd
    );


    setSelectValue(
      'nightStart',
      settings.nightStart
    );


    /*
     * 過去の設定で夜の終了が
     * 00:00になっている場合は
     * 24:00として読み込む。
     */
    const nightEnd =
      settings.nightEnd === '00:00'
        ? '24:00'
        : settings.nightEnd;


    setSelectValue(
      'nightEnd',
      nightEnd
    );


  } catch (error) {

    console.log(
      '設定の読み込みに失敗しました。',
      error
    );
  }
}


/* ==========================================
 * select値設定
 * ========================================== */

function setSelectValue(
  id,
  value
) {

  if (!value) {
    return;
  }


  const select =
    document.getElementById(id);


  const exists =
    Array.from(
      select.options
    )
      .some(
        option =>
          option.value === value
      );


  if (exists) {

    select.value =
      value;
  }
}


/* ==========================================
 * 設定保存
 * ========================================== */

function saveSettings() {

  const settings = {

    dayStart:
      document.getElementById(
        'dayStart'
      ).value,

    dayEnd:
      document.getElementById(
        'dayEnd'
      ).value,

    nightStart:
      document.getElementById(
        'nightStart'
      ).value,

    nightEnd:
      document.getElementById(
        'nightEnd'
      ).value,

    excludedCalendarIds:
      getExcludedCalendarIds()

  };


  localStorage.setItem(
    'proposedDateSettings',
    JSON.stringify(settings)
  );
}


/* ==========================================
 * カレンダー読み込み
 * ========================================== */

async function loadCalendars() {

  const emailElement =
    document.getElementById(
      'currentUserEmail'
    );


  emailElement.textContent =
    '確認中……';


  document.getElementById(
    'calendarList'
  ).textContent =
    'カレンダーを取得しています……';


  /*
   * 応答がないまま固まるのを防ぐためのタイムアウト処理。
   * ログイン待ちの間は動かないよう、ログイン後に開始する。
   */
  const emailTimer =
    setTimeout(
      function() {

        emailElement.textContent =
          '取得できません(タイムアウト)';
      },
      EMAIL_TIMEOUT_MS
    );


  try {

    const result =
      await calendarClient
        .listOwnedCalendars();


    clearTimeout(
      emailTimer
    );


    /*
     * 別のアカウントでログインし直したら
     * 前のアカウントの結果を残さない。
     */
    if (
      lastEmail !== null &&
      lastEmail !== result.primaryEmail
    ) {

      clearResult();

      lastFetch = null;
    }


    lastEmail =
      result.primaryEmail;


    ownedCalendars =
      result.calendars;


    emailElement.textContent =
      result.primaryEmail ||
      '取得できません';


    displayCalendars(
      result.calendars
    );

    return true;

  } catch (error) {

    clearTimeout(
      emailTimer
    );


    ownedCalendars =
      null;


    if (error instanceof AuthRequiredError) {

      document.getElementById(
        'calendarList'
      ).textContent =
        'ログインするとカレンダーを表示します。';

      return false;
    }


    emailElement.textContent =
      '取得できません';


    document.getElementById(
      'calendarList'
    ).innerHTML =
      '<div class="error">' +
      'カレンダーの取得に失敗しました。' +
      '<br>' +
      escapeHtml(
        describeError(error)
      ) +
      '</div>';

    return false;
  }
}


/* ==========================================
 * カレンダー表示
 * ========================================== */

function displayCalendars(
  calendars
) {

  const area =
    document.getElementById(
      'calendarList'
    );


  if (
    !calendars ||
    calendars.length === 0
  ) {

    area.innerHTML =
      '所有しているカレンダーがありません。';

    return;
  }


  let savedIds = [];


  const saved =
    localStorage.getItem(
      'proposedDateSettings'
    );


  if (saved) {

    try {

      const settings =
        JSON.parse(saved);


      savedIds =
        settings.excludedCalendarIds ||
        [];

    } catch (error) {

      savedIds = [];
    }
  }


  let html = '';


  calendars.forEach(
    calendar => {

      const checked =
        savedIds.includes(
          calendar.id
        )
          ? 'checked'
          : '';


      html += `

        <div class="calendar-item">

          <label>

            <input
              type="checkbox"
              class="excluded-calendar"
              value="${escapeHtml(
                calendar.id
              )}"
              ${checked}>

            ${escapeHtml(
              calendar.name
            )}

          </label>

        </div>

      `;
    }
  );


  area.innerHTML =
    html;


  document
    .querySelectorAll(
      '.excluded-calendar'
    )
    .forEach(
      checkbox => {

        checkbox.addEventListener(
          'change',
          saveSettings
        );

      }
    );
}


/* ==========================================
 * 全カレンダー選択
 * ========================================== */

function checkAllCalendars() {

  document
    .querySelectorAll(
      '.excluded-calendar'
    )
    .forEach(
      checkbox => {

        checkbox.checked =
          true;
      }
    );


  saveSettings();
}


/* ==========================================
 * 全カレンダー解除
 * ========================================== */

function uncheckAllCalendars() {

  document
    .querySelectorAll(
      '.excluded-calendar'
    )
    .forEach(
      checkbox => {

        checkbox.checked =
          false;
      }
    );


  saveSettings();
}


/* ==========================================
 * 除外カレンダー取得
 * ========================================== */

function getExcludedCalendarIds() {

  return Array.from(
    document.querySelectorAll(
      '.excluded-calendar:checked'
    )
  )
    .map(
      checkbox =>
        checkbox.value
    );
}


/* ==========================================
 * デバッグ切替
 * ========================================== */

function toggleDebug() {

  const enabled =
    document.getElementById(
      'debugEnabled'
    ).checked;


  document.getElementById(
    'debugSection'
  ).style.display =
    enabled
      ? 'block'
      : 'none';


  if (!enabled) {

    document.getElementById(
      'debugArea'
    ).innerHTML = '';
  }
}


/* ==========================================
 * 検索
 * ========================================== */

async function searchDates() {

  const startDate =
    document.getElementById(
      'startDate'
    ).value;


  const endDate =
    document.getElementById(
      'endDate'
    ).value;


  const dayStart =
    document.getElementById(
      'dayStart'
    ).value;


  const dayEnd =
    document.getElementById(
      'dayEnd'
    ).value;


  const nightStart =
    document.getElementById(
      'nightStart'
    ).value;


  const nightEnd =
    document.getElementById(
      'nightEnd'
    ).value;


  if (
    !startDate ||
    !endDate
  ) {

    document.getElementById(
      'status'
    ).innerHTML =
      '<div class="error">' +
      '開始日と終了日を指定してください。' +
      '</div>';

    return;
  }


  if (
    !dayStart ||
    !dayEnd ||
    !nightStart ||
    !nightEnd
  ) {

    document.getElementById(
      'status'
    ).innerHTML =
      '<div class="error">' +
      '時間設定をすべて指定してください。' +
      '</div>';

    return;
  }


  /* ----------------------------------------
   * 時間の前後関係を確認
   * ---------------------------------------- */

  if (
    timeToMinutes(dayStart) >=
    timeToMinutes(dayEnd)
  ) {

    document.getElementById(
      'status'
    ).innerHTML =
      '<div class="error">' +
      '昼の開始時刻は終了時刻より前にしてください。' +
      '</div>';

    return;
  }


  if (
    timeToMinutes(nightStart) >=
    timeToMinutes(nightEnd)
  ) {

    document.getElementById(
      'status'
    ).innerHTML =
      '<div class="error">' +
      '夜の開始時刻は終了時刻より前にしてください。' +
      '</div>';

    return;
  }


  if (
    !auth ||
    !auth.getAccessToken()
  ) {

    showStatus(
      'error',
      '先にGoogleでログインしてください。'
    );

    return;
  }


  try {

    validateSearchParams(
      startDate,
      endDate,
      dayStart,
      dayEnd,
      nightStart,
      nightEnd
    );

  } catch (error) {

    displayError(error);

    return;
  }


  const sequence =
    ++searchSequence;


  const searchButton =
    document.getElementById(
      'searchButton'
    );


  searchButton.disabled =
    true;


  document.getElementById(
    'status'
  ).innerHTML =
    '<div class="loading">' +
    '予定を取得しています……' +
    '</div>';


  const debugEnabled =
    document.getElementById(
      'debugEnabled'
    ).checked;


  if (debugEnabled) {

    document.getElementById(
      'debugArea'
    ).innerHTML =
      '取得中……';
  }


  try {

    /*
     * 一覧がないと除外の指定を読めず、
     * 保存済みの設定を空で上書きしてしまうので先に確認する。
     */
    if (!ownedCalendars) {

      await loadCalendars();
    }


    if (!ownedCalendars) {

      throw new Error(
        'カレンダーの一覧を取得できませんでした。'
      );
    }


    saveSettings();


    const excludedIds =
      getExcludedCalendarIds();


    const targets =
      selectTargetCalendars(
        ownedCalendars,
        excludedIds
      );


    const range =
      getFetchRange(
        startDate,
        endDate
      );


    const fetched =
      await calendarClient.fetchEvents(
        targets,
        range.timeMin,
        range.timeMax
      );


    if (sequence !== searchSequence) {
      return;
    }


    /*
     * 1つも読めていないのに「全日空き」と出さない。
     */
    if (
      targets.length > 0 &&
      fetched.succeeded.length === 0
    ) {

      throw fetched.failed[0].error;
    }


    const data =
      getProposedDates(
        startDate,
        endDate,
        dayStart,
        dayEnd,
        nightStart,
        nightEnd,
        excludedIds,
        fetched.succeeded
      );


    lastFetch = {
      calendars: fetched.succeeded
    };


    displayResult(
      data,
      fetched.failed
    );

  } catch (error) {

    /*
     * ログイン切れは handleAuthChange が表示済み。
     */
    if (error instanceof AuthRequiredError) {

      document.getElementById(
        'debugArea'
      ).innerHTML = '';

    } else {

      displayError(error);
    }

  } finally {

    searchButton.disabled =
      false;
  }
}


/* ==========================================
 * 時刻を分へ変換
 * ========================================== */

function timeToMinutes(
  value
) {

  const parts =
    value.split(':');


  const hour =
    Number(parts[0]);

  const minute =
    Number(parts[1]);


  return (
    hour * 60 +
    minute
  );
}


/* ==========================================
 * 結果表示
 * ========================================== */

function displayResult(
  data,
  failedCalendars
) {

  let statusHtml =
    '<div class="success">' +
    '取得完了' +
    '</div>';


  failedCalendars.forEach(
    calendar => {

      statusHtml +=
        '<div class="warning">' +
        '「' +
        escapeHtml(calendar.name) +
        '」の予定を取得できなかったため、判定に含まれていません。' +
        escapeHtml(
          describeError(calendar.error)
        ) +
        '</div>';
    }
  );


  document.getElementById(
    'status'
  ).innerHTML =
    statusHtml;


  lastResultDates =
    data.dates ||
    [];


  refreshOutputText();


  const debugEnabled =
    document.getElementById(
      'debugEnabled'
    ).checked;


  if (debugEnabled) {

    displayDebugList(
      data.debugDates
    );

  } else {

    document.getElementById(
      'debugArea'
    ).innerHTML = '';
  }
}


/* ==========================================
 * 出力テキスト生成
 * ========================================== */

function buildOutputText(
  dates
) {

  const includeTime =
    document.getElementById(
      'includeTime'
    ).checked;

  const zeroPad =
    document.getElementById(
      'zeroPad'
    ).checked;

  const monthDayOnly =
    document.getElementById(
      'monthDayOnly'
    ).checked;


  return dates
    .map(
      item => {

        const month =
          zeroPad
            ? String(
                item.month
              ).padStart(2, '0')
            : String(
                item.month
              );

        const day =
          zeroPad
            ? String(
                item.day
              ).padStart(2, '0')
            : String(
                item.day
              );

        const datePart =
          monthDayOnly
            ? `${month}/${day}`
            : `${item.year}/${month}/${day}`;


        let line =
          `${datePart}(${item.weekday})`;


        if (
          includeTime &&
          item.startTime
        ) {

          line +=
            ` ${item.startTime}〜`;
        }


        return line;
      }
    )
    .join('\n');
}


/* ==========================================
 * 出力テキスト再生成
 * ========================================== */

function refreshOutputText() {

  document.getElementById(
    'result'
  ).value =
    buildOutputText(
      lastResultDates
    );
}


/* ==========================================
 * デバッグ一覧
 * ========================================== */

function displayDebugList(
  debugDates
) {

  const area =
    document.getElementById(
      'debugArea'
    );


  if (
    !debugDates ||
    debugDates.length === 0
  ) {

    area.innerHTML =
      '対象期間に日付がありません。';

    return;
  }


  let html =
    '<div>' +
    '各日の判定を確認できます。' +
    '</div>';


  debugDates.forEach(
    (item, index) => {

      html += `

        <div class="debug-day">

          <div class="debug-title">

            ${escapeHtml(
              item.date
            )}

            (${escapeHtml(
              item.weekday
            )})

            —
            ${item.isTarget
              ? '対象'
              : '対象外'}

            —
            ${escapeHtml(
              item.reason
            )}

          </div>


          <button
            class="debug-detail-button"
            data-date="${escapeHtml(
              item.date
            )}"
            data-index="${index}">

            詳細を見る

          </button>


          <div
            id="debug-${index}"
            class="detail-area">
          </div>

        </div>

      `;
    }
  );


  area.innerHTML =
    html;
}


/* ==========================================
 * デバッグ詳細取得
 * ========================================== */

function loadDebug(
  date,
  index
) {

  const area =
    document.getElementById(
      `debug-${index}`
    );


  if (!lastFetch) {

    area.innerHTML =
      '<div class="error">' +
      'もう一度「予定を取得」してください。' +
      '</div>';

    return;
  }


  try {

    const excludedIds =
      getExcludedCalendarIds();


    displayDayDebug(

      getDayDebug(

        convertDisplayDateToInputDate(
          date
        ),

        document.getElementById(
          'dayStart'
        ).value,

        document.getElementById(
          'dayEnd'
        ).value,

        document.getElementById(
          'nightStart'
        ).value,

        document.getElementById(
          'nightEnd'
        ).value,

        excludedIds,

        lastFetch.calendars
      ),

      area,

      getUnfetchedCalendarNames(
        excludedIds
      )
    );

  } catch (error) {

    area.innerHTML =
      '<div class="error">' +
      'エラー：' +
      escapeHtml(
        error.message
      ) +
      '</div>';
  }
}


/*
 * 検索の後で除外を外したカレンダーや、取得に失敗したカレンダーは
 * 取得済みデータに含まれない。
 */
function getUnfetchedCalendarNames(
  excludedIds
) {

  const fetchedIds =
    new Set(
      lastFetch.calendars.map(
        calendar => calendar.id
      )
    );


  return selectTargetCalendars(
    ownedCalendars || [],
    excludedIds
  )
    .filter(
      calendar =>
        !fetchedIds.has(calendar.id)
    )
    .map(
      calendar =>
        calendar.name
    );
}


/* ==========================================
 * デバッグ詳細表示
 * ========================================== */

function formatEventNote(
  event
) {

  return event.note
    ? ` ※${escapeHtml(event.note)}`
    : '';
}


function displayDayDebug(
  data,
  area,
  unfetchedCalendarNames
) {

  let html = '';


  html += `
    <div class="detail-content">

      <div>
        <strong>判定：</strong>
        ${data.isTarget
          ? '対象'
          : '対象外'}
      </div>

      <div>
        <strong>理由：</strong>
        ${escapeHtml(
          data.reason
        )}
      </div>

      <hr>

      <div>
        終日予定：
        ${data.hasAllDayEvent
          ? 'あり'
          : 'なし'}
      </div>

      <div>
        昼：
        ${data.hasDaytimeEvent
          ? '予定あり'
          : '空き'}
      </div>

      <div>
        夜：
        ${data.hasNighttimeEvent
          ? '予定あり'
          : '空き'}
      </div>

      <hr>

      <strong>
        対象カレンダー
      </strong>

      <div>
        ${data.targetCalendars
          .map(
            name =>
              escapeHtml(name)
          )
          .join('<br>')}
      </div>
  `;


  if (
    data.events.length > 0
  ) {

    html += `
      <hr>

      <strong>
        この日の予定
      </strong>
    `;


    data.events.forEach(
      event => {

        html += `
          <div class="event">

            [${escapeHtml(
              event.calendar
            )}]

            ${escapeHtml(
              event.title
            )}

            (${escapeHtml(
              event.time
            )})${formatEventNote(event)}

          </div>
        `;
      }
    );

  } else {

    html += `
      <hr>
      この日の予定はありません。
    `;
  }


  if (
    data.daytimeEvents.length > 0
  ) {

    html += `
      <hr>

      <strong>
        昼判定に使われた予定
      </strong>
    `;


    data.daytimeEvents.forEach(
      event => {

        html += `
          <div class="event daytime">

            [${escapeHtml(
              event.calendar
            )}]

            ${escapeHtml(
              event.title
            )}

            (${escapeHtml(
              event.time
            )})${formatEventNote(event)}

          </div>
        `;
      }
    );
  }


  if (
    data.nighttimeEvents.length > 0
  ) {

    html += `
      <hr>

      <strong>
        夜判定に使われた予定
      </strong>
    `;


    data.nighttimeEvents.forEach(
      event => {

        html += `
          <div class="event nighttime">

            [${escapeHtml(
              event.calendar
            )}]

            ${escapeHtml(
              event.title
            )}

            (${escapeHtml(
              event.time
            )})${formatEventNote(event)}

          </div>
        `;
      }
    );
  }


  if (
    data.ignoredEvents.length > 0
  ) {

    html += `
      <hr>

      <strong>
        判定に使わなかった予定
      </strong>
    `;


    data.ignoredEvents.forEach(
      event => {

        html += `
          <div class="event">

            [${escapeHtml(
              event.calendar
            )}]

            ${escapeHtml(
              event.title
            )}

            (${escapeHtml(
              event.time
            )})${formatEventNote(event)}

          </div>
        `;
      }
    );
  }


  if (
    unfetchedCalendarNames.length > 0
  ) {

    html += `
      <hr>

      <div class="warning">
        次のカレンダーは取得済みの予定に含まれていません。除外の設定を変えた場合は、もう一度「予定を取得」してください。<br>
        ${unfetchedCalendarNames
          .map(
            name =>
              escapeHtml(name)
          )
          .join('<br>')}
      </div>
    `;
  }


  html += `
    </div>
  `;


  area.innerHTML =
    html;
}


/* ==========================================
 * エラー
 * ========================================== */

function displayError(
  error
) {

  const statusEl =
    document.getElementById(
      'status'
    );

  statusEl.innerHTML = '';

  const errorDiv =
    document.createElement(
      'div'
    );

  errorDiv.className =
    'error';

  errorDiv.textContent =
    'エラー：' +
    describeError(error);

  statusEl.appendChild(
    errorDiv
  );


  if (
    document.getElementById(
      'debugEnabled'
    ).checked
  ) {

    document.getElementById(
      'debugArea'
    ).innerHTML = '';
  }
}


/* ==========================================
 * コピー
 * ========================================== */

async function copyResult() {

  const result =
    document.getElementById(
      'result'
    );


  if (!result.value) {
    return;
  }


  try {

    await navigator.clipboard
      .writeText(
        result.value
      );


    document.getElementById(
      'status'
    ).innerHTML =
      '<div class="success">' +
      'コピーしました。' +
      '</div>';


  } catch (error) {

    result.focus();

    result.select();

    document.execCommand(
      'copy'
    );


    document.getElementById(
      'status'
    ).innerHTML =
      '<div class="success">' +
      'コピーしました。' +
      '</div>';
  }
}


/* ==========================================
 * クリア
 * ========================================== */

function clearResult() {

  lastResultDates = [];


  document.getElementById(
    'result'
  ).value = '';


  document.getElementById(
    'status'
  ).innerHTML = '';


  if (
    document.getElementById(
      'debugEnabled'
    ).checked
  ) {

    document.getElementById(
      'debugArea'
    ).innerHTML =
      '対象期間を検索すると、各日の判定を確認できます。';

  } else {

    document.getElementById(
      'debugArea'
    ).innerHTML = '';
  }
}


/* ==========================================
 * 日付
 * ========================================== */

function formatInputDate(
  date
) {

  const year =
    date.getFullYear();


  const month =
    String(
      date.getMonth() + 1
    ).padStart(2, '0');


  const day =
    String(
      date.getDate()
    ).padStart(2, '0');


  return (
    `${year}-${month}-${day}`
  );
}


function convertDisplayDateToInputDate(
  date
) {

  return date.replace(
    /\//g,
    '-'
  );
}


/* ==========================================
 * HTMLエスケープ
 * ========================================== */

function escapeHtml(
  value
) {

  return String(value)

    .replace(
      /&/g,
      '&amp;'
    )

    .replace(
      /</g,
      '&lt;'
    )

    .replace(
      />/g,
      '&gt;'
    )

    .replace(
      /"/g,
      '&quot;'
    )

    .replace(
      /'/g,
      '&#039;'
    );
}
