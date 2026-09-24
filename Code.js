/**
 * ==========================================
 * 予定抽出
 * ==========================================
 *
 * 昼または夜のどちらか一方でも空いている日を
 * 日程調整用の日付として出力します。
 *
 * ・昼：13:00〜18:00
 * ・夜：21:00〜24:00
 *
 * ※時間帯は画面から変更できます。
 * ※終日予定がある日は対象外です。
 * ※検索期間は最大180日です。
 * ※「ToDo リスト」は常に除外します。
 */


/* ==========================================
 * 初期設定
 * ========================================== */

// 昼の初期値
const DEFAULT_DAY_START = '13:00';
const DEFAULT_DAY_END = '18:00';

// 夜の初期値
const DEFAULT_NIGHT_START = '21:00';
const DEFAULT_NIGHT_END = '24:00';

// 検索期間の最大日数
const MAX_SEARCH_DAYS = 180;

// 常に除外するカレンダー
const FIXED_EXCLUDED_CALENDAR_NAME = 'ToDo リスト';


/* ==========================================
 * Webアプリ表示
 * ========================================== */

function doGet() {

  return HtmlService
    .createHtmlOutputFromFile('index')
    .setTitle('予定抽出')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}


/* ==========================================
 * カレンダー一覧取得
 * ========================================== */

/**
 * ユーザーが所有しているカレンダー一覧を取得。
 *
 * 「ToDo リスト」は固定除外のため
 * 一覧には表示しない。
 */
function getOwnedCalendars() {

  return CalendarApp
    .getAllOwnedCalendars()
    .filter(calendar =>
      calendar.getName() !==
      FIXED_EXCLUDED_CALENDAR_NAME
    )
    .map(calendar => ({
      id: calendar.getId(),
      name: calendar.getName()
    }))
    .sort((a, b) =>
      a.name.localeCompare(
        b.name,
        'ja'
      )
    );
}


/**
 * 選択された除外カレンダーを除いた
 * 対象カレンダーを取得。
 *
 * 「ToDo リスト」は常に除外。
 */
function getTargetCalendars_(
  excludedCalendarIds
) {

  const excluded =
    new Set(
      excludedCalendarIds || []
    );


  return CalendarApp
    .getAllOwnedCalendars()
    .filter(calendar => {

      // ToDo リストは常に除外
      if (
        calendar.getName() ===
        FIXED_EXCLUDED_CALENDAR_NAME
      ) {
        return false;
      }


      // 画面で指定された除外カレンダー
      if (
        excluded.has(
          calendar.getId()
        )
      ) {
        return false;
      }


      return true;
    });
}


/* ==========================================
 * 対象日付取得
 * ========================================== */

/**
 * 出力対象の日付を取得。
 *
 * 昼または夜のどちらか一方でも空いていれば対象。
 *
 * @param {string} startDateStr YYYY-MM-DD
 * @param {string} endDateStr YYYY-MM-DD
 * @param {string} dayStartStr HH:mm
 * @param {string} dayEndStr HH:mm
 * @param {string} nightStartStr HH:mm
 * @param {string} nightEndStr HH:mm
 * @param {string[]} excludedCalendarIds
 */
function getProposedDates(
  startDateStr,
  endDateStr,
  dayStartStr,
  dayEndStr,
  nightStartStr,
  nightEndStr,
  excludedCalendarIds
) {

  const startDate =
    parseDate_(startDateStr);

  const endDate =
    parseDate_(endDateStr);


  if (!startDate || !endDate) {

    throw new Error(
      '開始日または終了日の形式が正しくありません。'
    );
  }


  if (startDate > endDate) {

    throw new Error(
      '開始日は終了日以前にしてください。'
    );
  }


  /* ------------------------------------------
   * 検索期間チェック
   * ------------------------------------------ */

  const searchDays =
    Math.floor(
      (
        endDate.getTime() -
        startDate.getTime()
      ) /
      (1000 * 60 * 60 * 24)
    ) + 1;


  if (
    searchDays > MAX_SEARCH_DAYS
  ) {

    throw new Error(
      `検索期間は最大${MAX_SEARCH_DAYS}日です。`
    );
  }


  /* ------------------------------------------
   * 時間設定チェック
   * ------------------------------------------ */

  const dayStart =
    parseTime_(dayStartStr);

  const dayEnd =
    parseTime_(dayEndStr);

  const nightStart =
    parseTime_(nightStartStr);

  const nightEnd =
    parseTime_(nightEndStr);


  if (
    !dayStart ||
    !dayEnd ||
    !nightStart ||
    !nightEnd
  ) {

    throw new Error(
      '時間設定が正しくありません。'
    );
  }


  if (
    timeToMinutes_(dayStart) >=
    timeToMinutes_(dayEnd)
  ) {

    throw new Error(
      '昼の開始時刻は終了時刻より前にしてください。'
    );
  }


  if (
    timeToMinutes_(nightStart) >=
    timeToMinutes_(nightEnd)
  ) {

    throw new Error(
      '夜の開始時刻は終了時刻より前にしてください。'
    );
  }


  /* ------------------------------------------
   * カレンダー取得
   * ------------------------------------------ */

  const targetCalendars =
    getTargetCalendars_(
      excludedCalendarIds
    );


  const results = [];
  const debugDates = [];


  let currentDate =
    new Date(startDate);


  while (
    currentDate <= endDate
  ) {

    const result =
      checkDate_(
        currentDate,
        targetCalendars,
        dayStart,
        dayEnd,
        nightStart,
        nightEnd
      );


    const dateText =
      formatDate_(currentDate);


    /* ----------------------------------------
     * 出力対象
     * ---------------------------------------- */

    if (
      result.isTarget
    ) {

      results.push({

        date:
          dateText,

        weekday:
          getWeekday_(currentDate),

        reason:
          result.reason,

        year:
          currentDate.getFullYear(),

        month:
          currentDate.getMonth() + 1,

        day:
          currentDate.getDate(),

        startTime:
          getAvailableStartTime_(
            result,
            dayStartStr,
            nightStartStr,
            dayStart,
            nightStart
          )

      });
    }


    /* ----------------------------------------
     * デバッグ用
     * ---------------------------------------- */

    debugDates.push({

      date:
        dateText,

      weekday:
        getWeekday_(currentDate),

      isTarget:
        result.isTarget,

      reason:
        result.reason

    });


    currentDate.setDate(
      currentDate.getDate() + 1
    );
  }


  return {

    dates:
      results,


    output:
      results
        .map(
          item =>
            `${item.date}(${item.weekday})`
        )
        .join('\n'),


    targetCalendarCount:
      targetCalendars.length,


    targetCalendars:
      targetCalendars.map(
        calendar =>
          calendar.getName()
      ),


    debugDates:
      debugDates
  };
}


/* ==========================================
 * 1日の判定
 * ========================================== */

/**
 * 1日の空き状況を判定。
 */
function checkDate_(
  date,
  targetCalendars,
  dayStartTime,
  dayEndTime,
  nightStartTime,
  nightEndTime
) {

  const dayStart =
    new Date(date);

  dayStart.setHours(
    0,
    0,
    0,
    0
  );


  const nextDay =
    new Date(dayStart);

  nextDay.setDate(
    nextDay.getDate() + 1
  );


  /* ------------------------------------------
   * 昼時間帯
   * ------------------------------------------ */

  const daytimeStart =
    new Date(dayStart);

  daytimeStart.setHours(
    dayStartTime.hour,
    dayStartTime.minute,
    0,
    0
  );


  const daytimeEnd =
    new Date(dayStart);

  daytimeEnd.setHours(
    dayEndTime.hour,
    dayEndTime.minute,
    0,
    0
  );


  /* ------------------------------------------
   * 夜時間帯
   * ------------------------------------------ */

  const nighttimeStart =
    new Date(dayStart);

  nighttimeStart.setHours(
    nightStartTime.hour,
    nightStartTime.minute,
    0,
    0
  );


  const nighttimeEnd =
    new Date(dayStart);


  /*
   * 24:00は翌日の00:00として扱う
   */
  if (
    nightEndTime.hour === 24
  ) {

    nighttimeEnd.setDate(
      nighttimeEnd.getDate() + 1
    );

    nighttimeEnd.setHours(
      0,
      nightEndTime.minute,
      0,
      0
    );

  } else {

    nighttimeEnd.setHours(
      nightEndTime.hour,
      nightEndTime.minute,
      0,
      0
    );
  }


  let hasAllDayEvent =
    false;

  let hasDaytimeEvent =
    false;

  let hasNighttimeEvent =
    false;


  /* ------------------------------------------
   * 予定確認
   * ------------------------------------------ */

  for (
    const calendar of targetCalendars
  ) {

    const events =
      calendar.getEvents(
        dayStart,
        nextDay
      );


    for (
      const event of events
    ) {

      /* 終日予定 */

      if (
        event.isAllDayEvent()
      ) {

        hasAllDayEvent =
          true;

        continue;
      }


      const eventStart =
        event.getStartTime();

      const eventEnd =
        event.getEndTime();


      /* 昼 */

      if (
        isOverlapping_(
          eventStart,
          eventEnd,
          daytimeStart,
          daytimeEnd
        )
      ) {

        hasDaytimeEvent =
          true;
      }


      /* 夜 */

      if (
        isOverlapping_(
          eventStart,
          eventEnd,
          nighttimeStart,
          nighttimeEnd
        )
      ) {

        hasNighttimeEvent =
          true;
      }
    }
  }


  /* ------------------------------------------
   * 最終判定
   * ------------------------------------------ */

  const isTarget =
    !hasAllDayEvent &&
    (
      !hasDaytimeEvent ||
      !hasNighttimeEvent
    );


  return {

    isTarget:
      isTarget,

    reason:
      getReason_(
        hasAllDayEvent,
        hasDaytimeEvent,
        hasNighttimeEvent
      ),

    hasAllDayEvent:
      hasAllDayEvent,

    hasDaytimeEvent:
      hasDaytimeEvent,

    hasNighttimeEvent:
      hasNighttimeEvent
  };
}


/* ==========================================
 * デバッグ詳細
 * ========================================== */

function getDayDebug(
  dateStr,
  dayStartStr,
  dayEndStr,
  nightStartStr,
  nightEndStr,
  excludedCalendarIds
) {

  const date =
    parseDate_(dateStr);


  if (!date) {

    throw new Error(
      '日付の形式が正しくありません。'
    );
  }


  const dayStartTime =
    parseTime_(dayStartStr);

  const dayEndTime =
    parseTime_(dayEndStr);

  const nightStartTime =
    parseTime_(nightStartStr);

  const nightEndTime =
    parseTime_(nightEndStr);


  if (
    !dayStartTime ||
    !dayEndTime ||
    !nightStartTime ||
    !nightEndTime
  ) {

    throw new Error(
      '時間設定が正しくありません。'
    );
  }


  const targetCalendars =
    getTargetCalendars_(
      excludedCalendarIds
    );


  const dayStart =
    new Date(date);

  dayStart.setHours(
    0,
    0,
    0,
    0
  );


  const nextDay =
    new Date(dayStart);

  nextDay.setDate(
    nextDay.getDate() + 1
  );


  const daytimeStart =
    new Date(dayStart);

  daytimeStart.setHours(
    dayStartTime.hour,
    dayStartTime.minute,
    0,
    0
  );


  const daytimeEnd =
    new Date(dayStart);

  daytimeEnd.setHours(
    dayEndTime.hour,
    dayEndTime.minute,
    0,
    0
  );


  const nighttimeStart =
    new Date(dayStart);

  nighttimeStart.setHours(
    nightStartTime.hour,
    nightStartTime.minute,
    0,
    0
  );


  const nighttimeEnd =
    new Date(dayStart);


  if (
    nightEndTime.hour === 24
  ) {

    nighttimeEnd.setDate(
      nighttimeEnd.getDate() + 1
    );

    nighttimeEnd.setHours(
      0,
      nightEndTime.minute,
      0,
      0
    );

  } else {

    nighttimeEnd.setHours(
      nightEndTime.hour,
      nightEndTime.minute,
      0,
      0
    );
  }


  const events = [];
  const daytimeEvents = [];
  const nighttimeEvents = [];


  let hasAllDayEvent =
    false;


  for (
    const calendar of targetCalendars
  ) {

    const calendarEvents =
      calendar.getEvents(
        dayStart,
        nextDay
      );


    for (
      const event of calendarEvents
    ) {

      const eventName =
        event.getTitle();

      const eventStart =
        event.getStartTime();

      const eventEnd =
        event.getEndTime();

      const isAllDay =
        event.isAllDayEvent();


      const eventInfo = {

        calendar:
          calendar.getName(),

        title:
          eventName,

        allDay:
          isAllDay,

        time:
          isAllDay
            ? '終日'
            : `${formatDateTime_(eventStart)}〜${formatDateTime_(eventEnd)}`
      };


      events.push(
        eventInfo
      );


      if (isAllDay) {

        hasAllDayEvent =
          true;

        continue;
      }


      if (
        isOverlapping_(
          eventStart,
          eventEnd,
          daytimeStart,
          daytimeEnd
        )
      ) {

        daytimeEvents.push(
          eventInfo
        );
      }


      if (
        isOverlapping_(
          eventStart,
          eventEnd,
          nighttimeStart,
          nighttimeEnd
        )
      ) {

        nighttimeEvents.push(
          eventInfo
        );
      }
    }
  }


  const hasDaytimeEvent =
    daytimeEvents.length > 0;

  const hasNighttimeEvent =
    nighttimeEvents.length > 0;


  const isTarget =
    !hasAllDayEvent &&
    (
      !hasDaytimeEvent ||
      !hasNighttimeEvent
    );


  return {

    date:
      formatDate_(date),

    weekday:
      getWeekday_(date),

    isTarget:
      isTarget,

    reason:
      getReason_(
        hasAllDayEvent,
        hasDaytimeEvent,
        hasNighttimeEvent
      ),

    hasAllDayEvent:
      hasAllDayEvent,

    hasDaytimeEvent:
      hasDaytimeEvent,

    hasNighttimeEvent:
      hasNighttimeEvent,

    targetCalendars:
      targetCalendars.map(
        calendar =>
          calendar.getName()
      ),

    events:
      events,

    daytimeEvents:
      daytimeEvents,

    nighttimeEvents:
      nighttimeEvents
  };
}


/* ==========================================
 * 判定理由
 * ========================================== */

function getReason_(
  hasAllDayEvent,
  hasDaytimeEvent,
  hasNighttimeEvent
) {

  if (hasAllDayEvent) {
    return '終日予定あり・対象外';
  }

  if (
    hasDaytimeEvent &&
    hasNighttimeEvent
  ) {
    return '昼・夜ともに予定あり・対象外';
  }

  if (hasDaytimeEvent) {
    return '昼に予定あり・夜は空き・対象';
  }

  if (hasNighttimeEvent) {
    return '昼は空き・夜に予定あり・対象';
  }

  return '昼・夜ともに空き・対象';
}


/* ==========================================
 * 空いている時間帯の開始時刻
 * ========================================== */

/**
 * 昼・夜のうち空いている方の開始時刻を返す。
 *
 * 両方空いている場合は、より早い方の開始時刻を返す。
 */
function getAvailableStartTime_(
  result,
  dayStartStr,
  nightStartStr,
  dayStartTime,
  nightStartTime
) {

  const dayFree =
    !result.hasDaytimeEvent;

  const nightFree =
    !result.hasNighttimeEvent;


  if (
    dayFree &&
    nightFree
  ) {

    return (
      timeToMinutes_(dayStartTime) <=
      timeToMinutes_(nightStartTime)
    )
      ? dayStartStr
      : nightStartStr;
  }


  if (dayFree) {
    return dayStartStr;
  }


  if (nightFree) {
    return nightStartStr;
  }


  return null;
}


/* ==========================================
 * 時刻
 * ========================================== */

function parseTime_(
  timeStr
) {

  if (!timeStr) {
    return null;
  }


  const match =
    /^(\d{1,2}):(\d{2})$/
      .exec(timeStr);


  if (!match) {
    return null;
  }


  const hour =
    Number(match[1]);

  const minute =
    Number(match[2]);


  if (
    hour < 0 ||
    hour > 24 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }


  if (
    hour === 24 &&
    minute !== 0
  ) {
    return null;
  }


  return {
    hour: hour,
    minute: minute
  };
}


function timeToMinutes_(
  time
) {

  return (
    time.hour * 60 +
    time.minute
  );
}


/* ==========================================
 * 重複判定
 * ========================================== */

function isOverlapping_(
  eventStart,
  eventEnd,
  rangeStart,
  rangeEnd
) {

  return (
    eventStart < rangeEnd &&
    eventEnd > rangeStart
  );
}


/* ==========================================
 * 日付
 * ========================================== */

function parseDate_(
  dateStr
) {

  if (!dateStr) {
    return null;
  }


  const match =
    /^(\d{4})-(\d{2})-(\d{2})$/
      .exec(dateStr);


  if (!match) {
    return null;
  }


  const year =
    Number(match[1]);

  const month =
    Number(match[2]) - 1;

  const day =
    Number(match[3]);


  const date =
    new Date(
      year,
      month,
      day
    );


  date.setHours(
    0,
    0,
    0,
    0
  );


  return date;
}


/* ==========================================
 * フォーマット
 * ========================================== */

function formatDate_(
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


  return `${year}/${month}/${day}`;
}


function formatDateTime_(
  date
) {

  const dateText =
    formatDate_(date);

  const hours =
    String(
      date.getHours()
    ).padStart(2, '0');

  const minutes =
    String(
      date.getMinutes()
    ).padStart(2, '0');


  return `${dateText} ${hours}:${minutes}`;
}


function getWeekday_(
  date
) {

  const weekdays = [
    '日',
    '月',
    '火',
    '水',
    '木',
    '金',
    '土'
  ];


  return weekdays[
    date.getDay()
  ];
}

function getCurrentUserEmail() {

  try {

    return (
      Session.getActiveUser().getEmail() ||
      Session.getEffectiveUser().getEmail() ||
      ''
    );

  } catch (error) {

    return '';
  }
}