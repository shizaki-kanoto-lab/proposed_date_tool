/**
 * 空き日程の判定処理（Code.js の移植）。
 *
 * 画面や通信に依存しない純粋な処理だけを置く。
 * 出力の形と文言は Code.js の getProposedDates / getDayDebug と揃える。
 * 揃っていることは test/parity.test.js で Code.js と突き合わせて確認している。
 */

export const MAX_SEARCH_DAYS = 180;
export const FIXED_EXCLUDED_CALENDAR_NAME = 'ToDo リスト';

/**
 * 判定に使わず、デバッグにだけ出す予定の種別。
 *
 * events.list は勤務場所も返すため、そのまま扱うと設定している人は毎日が
 * 終日予定で対象外になる。GAS版での扱いは実データがなく未確認。
 */
export const IGNORED_EVENT_TYPES = new Map([
  ['workingLocation', '勤務場所']
]);

/**
 * 判定には使うが、デバッグで種別を示す予定。
 *
 * 誕生日はGAS版と同じく終日予定として数える（実データの比較で確認済み）。
 */
const LABELED_EVENT_TYPES = new Map([
  ['birthday', '誕生日']
]);


/* ==========================================
 * 入力チェック
 * ========================================== */

function requireTimes_(dayStartStr, dayEndStr, nightStartStr, nightEndStr) {
  const times = {
    dayStart: parseTime(dayStartStr),
    dayEnd: parseTime(dayEndStr),
    nightStart: parseTime(nightStartStr),
    nightEnd: parseTime(nightEndStr)
  };

  if (!times.dayStart || !times.dayEnd || !times.nightStart || !times.nightEnd) {
    throw new Error('時間設定が正しくありません。');
  }

  return times;
}


/**
 * 検索条件を確認する。通信の前に呼べるよう判定とは分けている。
 */
export function validateSearchParams(
  startDateStr, endDateStr, dayStartStr, dayEndStr, nightStartStr, nightEndStr
) {
  const startDate = parseDate(startDateStr);
  const endDate = parseDate(endDateStr);

  if (!startDate || !endDate) {
    throw new Error('開始日または終了日の形式が正しくありません。');
  }

  if (startDate > endDate) {
    throw new Error('開始日は終了日以前にしてください。');
  }

  // 夏時間の日をまたいでも日数がずれないよう、丸めて数える
  const searchDays =
    Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  if (searchDays > MAX_SEARCH_DAYS) {
    throw new Error(`検索期間は最大${MAX_SEARCH_DAYS}日です。`);
  }

  const times = requireTimes_(dayStartStr, dayEndStr, nightStartStr, nightEndStr);

  if (timeToMinutes(times.dayStart) >= timeToMinutes(times.dayEnd)) {
    throw new Error('昼の開始時刻は終了時刻より前にしてください。');
  }

  if (timeToMinutes(times.nightStart) >= timeToMinutes(times.nightEnd)) {
    throw new Error('夜の開始時刻は終了時刻より前にしてください。');
  }

  return { startDate, endDate, times };
}


/* ==========================================
 * Calendar API の応答の変換
 * ========================================== */

/**
 * calendarList.list の items を画面用に変換する。
 * getOwnedCalendars と同じく ToDo リストを除き、名前順に並べる。
 *
 * primaryEmail は主カレンダーのID。メールアドレスの形でなければ null。
 */
export function normalizeCalendarList(items) {
  const entries = items || [];

  const calendars = entries
    .filter(item =>
      item.summary !== FIXED_EXCLUDED_CALENDAR_NAME &&
      item.summaryOverride !== FIXED_EXCLUDED_CALENDAR_NAME
    )
    .map(item => ({
      id: item.id,
      name: item.summaryOverride || item.summary || ''
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  const primary = entries.find(item => item.primary);
  const primaryEmail =
    primary && /^[^@\s]+@[^@\s]+$/.test(primary.id) ? primary.id : null;

  return { calendars, primaryEmail };
}


/**
 * events.list の items を判定用に変換する。
 * 終日予定の end.date は含まれない日（翌日）として扱う。
 */
export function normalizeApiEvents(items) {
  return (items || [])
    .filter(item => item.status !== 'cancelled' && item.start && item.end)
    .map(item => {
      const allDay = Boolean(item.start.date);
      const self = (item.attendees || []).find(attendee => attendee.self);

      return {
        title: item.summary || '',
        allDay,
        startDate: allDay ? item.start.date : null,
        endDate: allDay ? item.end.date : null,
        start: allDay ? parseDate(item.start.date) : new Date(item.start.dateTime),
        end: allDay ? parseDate(item.end.date) : new Date(item.end.dateTime),
        eventType: item.eventType || 'default',
        transparency: item.transparency || 'opaque',
        responseStatus: self ? self.responseStatus : null
      };
    });
}


/**
 * events.list に渡す期間。
 *
 * 終日予定の絞り込みがカレンダー側のタイムゾーンで行われても取りこぼさないよう
 * 前後に1日広げて取得する。日ごとの判定はブラウザの時刻で行うので結果は変わらない。
 */
export function getFetchRange(startDateStr, endDateStr) {
  const timeMin = parseDate(startDateStr);
  timeMin.setDate(timeMin.getDate() - 1);

  const timeMax = parseDate(endDateStr);
  timeMax.setDate(timeMax.getDate() + 2);

  return { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString() };
}


/**
 * 除外指定と ToDo リストを除いた対象カレンダー。
 */
export function selectTargetCalendars(calendars, excludedCalendarIds) {
  const excluded = new Set(excludedCalendarIds || []);

  return calendars.filter(calendar =>
    calendar.name !== FIXED_EXCLUDED_CALENDAR_NAME &&
    !excluded.has(calendar.id)
  );
}


/* ==========================================
 * 対象日付取得
 * ========================================== */

/**
 * @param {{id: string, name: string, events: object[]}[]} calendars 取得済みの予定
 */
export function getProposedDates(
  startDateStr, endDateStr, dayStartStr, dayEndStr, nightStartStr, nightEndStr,
  excludedCalendarIds, calendars
) {
  const { startDate, endDate, times } = validateSearchParams(
    startDateStr, endDateStr, dayStartStr, dayEndStr, nightStartStr, nightEndStr
  );

  const targetCalendars = selectTargetCalendars(calendars, excludedCalendarIds);

  const results = [];
  const debugDates = [];

  const currentDate = new Date(startDate);

  while (currentDate <= endDate) {
    const result = evaluateDay_(currentDate, targetCalendars, times);
    const dateText = formatDate(currentDate);
    const weekday = getWeekday(currentDate);

    if (result.isTarget) {
      results.push({
        date: dateText,
        weekday,
        reason: result.reason,
        year: currentDate.getFullYear(),
        month: currentDate.getMonth() + 1,
        day: currentDate.getDate(),
        startTime: getAvailableStartTime_(
          result, dayStartStr, nightStartStr, times.dayStart, times.nightStart
        )
      });
    }

    debugDates.push({
      date: dateText,
      weekday,
      isTarget: result.isTarget,
      reason: result.reason
    });

    currentDate.setDate(currentDate.getDate() + 1);
  }

  return {
    dates: results,
    output: results.map(item => `${item.date}(${item.weekday})`).join('\n'),
    targetCalendarCount: targetCalendars.length,
    targetCalendars: targetCalendars.map(calendar => calendar.name),
    debugDates
  };
}


/* ==========================================
 * デバッグ詳細
 * ========================================== */

/**
 * Code.js の getDayDebug と同じ形に ignoredEvents を足して返す。
 */
export function getDayDebug(
  dateStr, dayStartStr, dayEndStr, nightStartStr, nightEndStr,
  excludedCalendarIds, calendars
) {
  const date = parseDate(dateStr);

  if (!date) {
    throw new Error('日付の形式が正しくありません。');
  }

  const times = requireTimes_(dayStartStr, dayEndStr, nightStartStr, nightEndStr);
  const targetCalendars = selectTargetCalendars(calendars, excludedCalendarIds);
  const result = evaluateDay_(date, targetCalendars, times);

  return {
    date: formatDate(date),
    weekday: getWeekday(date),
    isTarget: result.isTarget,
    reason: result.reason,
    hasAllDayEvent: result.hasAllDayEvent,
    hasDaytimeEvent: result.hasDaytimeEvent,
    hasNighttimeEvent: result.hasNighttimeEvent,
    targetCalendars: targetCalendars.map(calendar => calendar.name),
    events: result.events,
    daytimeEvents: result.daytimeEvents,
    nighttimeEvents: result.nighttimeEvents,
    ignoredEvents: result.ignoredEvents
  };
}


/* ==========================================
 * 1日の判定
 * ========================================== */

function atTime_(dayStart, time) {
  const value = new Date(dayStart);

  // 24:00 は翌日の 00:00 として扱う
  value.setHours(time.hour, time.minute, 0, 0);

  return value;
}


function isOnDay_(event, dateKey, dayStart, nextDay) {
  if (event.allDay) {
    return event.startDate <= dateKey && dateKey < event.endDate;
  }

  return isOverlapping_(event.start, event.end, dayStart, nextDay);
}


function getEventNote_(event) {
  const notes = [];

  if (IGNORED_EVENT_TYPES.has(event.eventType)) {
    notes.push(IGNORED_EVENT_TYPES.get(event.eventType));
  }

  if (LABELED_EVENT_TYPES.has(event.eventType)) {
    notes.push(LABELED_EVENT_TYPES.get(event.eventType));
  }

  if (event.responseStatus === 'declined') {
    notes.push('辞退');
  }

  if (event.transparency === 'transparent') {
    notes.push('空き時間扱い');
  }

  return notes.join('・');
}


function evaluateDay_(date, targetCalendars, times) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);

  const nextDay = new Date(dayStart);
  nextDay.setDate(nextDay.getDate() + 1);

  const dateKey = toDateKey(dayStart);

  const daytimeStart = atTime_(dayStart, times.dayStart);
  const daytimeEnd = atTime_(dayStart, times.dayEnd);
  const nighttimeStart = atTime_(dayStart, times.nightStart);
  const nighttimeEnd = atTime_(dayStart, times.nightEnd);

  const events = [];
  const daytimeEvents = [];
  const nighttimeEvents = [];
  const ignoredEvents = [];

  let hasAllDayEvent = false;

  for (const calendar of targetCalendars) {
    for (const event of calendar.events) {
      if (!isOnDay_(event, dateKey, dayStart, nextDay)) {
        continue;
      }

      const eventInfo = {
        calendar: calendar.name,
        title: event.title,
        allDay: event.allDay,
        time: event.allDay
          ? '終日'
          : `${formatDateTime(event.start)}〜${formatDateTime(event.end)}`
      };

      const note = getEventNote_(event);

      if (note) {
        eventInfo.note = note;
      }

      if (IGNORED_EVENT_TYPES.has(event.eventType)) {
        ignoredEvents.push(eventInfo);
        continue;
      }

      events.push(eventInfo);

      if (event.allDay) {
        hasAllDayEvent = true;
        continue;
      }

      if (isOverlapping_(event.start, event.end, daytimeStart, daytimeEnd)) {
        daytimeEvents.push(eventInfo);
      }

      if (isOverlapping_(event.start, event.end, nighttimeStart, nighttimeEnd)) {
        nighttimeEvents.push(eventInfo);
      }
    }
  }

  const hasDaytimeEvent = daytimeEvents.length > 0;
  const hasNighttimeEvent = nighttimeEvents.length > 0;

  return {
    isTarget: !hasAllDayEvent && (!hasDaytimeEvent || !hasNighttimeEvent),
    reason: getReason_(hasAllDayEvent, hasDaytimeEvent, hasNighttimeEvent),
    hasAllDayEvent,
    hasDaytimeEvent,
    hasNighttimeEvent,
    events,
    daytimeEvents,
    nighttimeEvents,
    ignoredEvents
  };
}


function getReason_(hasAllDayEvent, hasDaytimeEvent, hasNighttimeEvent) {
  if (hasAllDayEvent) {
    return '終日予定あり・対象外';
  }

  if (hasDaytimeEvent && hasNighttimeEvent) {
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


/**
 * 昼・夜のうち空いている方の開始時刻。両方空いていれば早い方。
 */
function getAvailableStartTime_(
  result, dayStartStr, nightStartStr, dayStartTime, nightStartTime
) {
  const dayFree = !result.hasDaytimeEvent;
  const nightFree = !result.hasNighttimeEvent;

  if (dayFree && nightFree) {
    return timeToMinutes(dayStartTime) <= timeToMinutes(nightStartTime)
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


function isOverlapping_(eventStart, eventEnd, rangeStart, rangeEnd) {
  return eventStart < rangeEnd && eventEnd > rangeStart;
}


/* ==========================================
 * 時刻・日付
 * ========================================== */

export function parseTime(timeStr) {
  if (!timeStr) {
    return null;
  }

  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr);

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) {
    return null;
  }

  return { hour, minute };
}


export function timeToMinutes(time) {
  return time.hour * 60 + time.minute;
}


export function parseDate(dateStr) {
  if (!dateStr) {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);

  if (!match) {
    return null;
  }

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}


function pad2_(value) {
  return String(value).padStart(2, '0');
}


function toDateKey(date) {
  return `${date.getFullYear()}-${pad2_(date.getMonth() + 1)}-${pad2_(date.getDate())}`;
}


export function formatDate(date) {
  return `${date.getFullYear()}/${pad2_(date.getMonth() + 1)}/${pad2_(date.getDate())}`;
}


function formatDateTime(date) {
  return `${formatDate(date)} ${pad2_(date.getHours())}:${pad2_(date.getMinutes())}`;
}


export function getWeekday(date) {
  return ['日', '月', '火', '水', '木', '金', '土'][date.getDay()];
}
