import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getDayDebug,
  getFetchRange,
  getProposedDates,
  normalizeApiEvents,
  normalizeCalendarList,
  selectTargetCalendars
} from '../web/core.js';

const local = (date, time) => new Date(`${date}T${time}:00`).toISOString();
const timed = (date, start, end, extra = {}) => ({
  summary: '架空の予定',
  start: { dateTime: local(date, start) },
  end: { dateTime: local(date, end) },
  ...extra
});
const allDay = (start, end, extra = {}) => ({
  summary: '架空の終日予定',
  start: { date: start },
  end: { date: end },
  ...extra
});
const calendar = (items, id = 'cal-a', name = '架空カレンダー') => ({
  id, name, events: normalizeApiEvents(items)
});

const search = (start, end, items, times = ['13:00', '18:00', '21:00', '24:00']) =>
  getProposedDates(start, end, ...times, [], [calendar(items)]);

const reasonOf = (date, items) => search(date, date, items).debugDates[0].reason;


test('判定理由は Code.js と同じ文言になる', () => {
  const date = '2026-12-01';

  assert.equal(reasonOf(date, []), '昼・夜ともに空き・対象');
  assert.equal(reasonOf(date, [timed(date, '14:00', '15:00')]), '昼に予定あり・夜は空き・対象');
  assert.equal(reasonOf(date, [timed(date, '22:00', '23:00')]), '昼は空き・夜に予定あり・対象');
  assert.equal(
    reasonOf(date, [timed(date, '14:00', '15:00'), timed(date, '22:00', '23:00')]),
    '昼・夜ともに予定あり・対象外'
  );
  assert.equal(reasonOf(date, [allDay(date, '2026-12-02')]), '終日予定あり・対象外');
});


test('出力の形と開始時刻', () => {
  const result = search('2026-12-01', '2026-12-03', [
    timed('2026-12-01', '14:00', '15:00'),
    allDay('2026-12-02', '2026-12-03')
  ]);

  assert.equal(result.output, '2026/12/01(火)\n2026/12/03(木)');
  assert.deepEqual(result.dates[0], {
    date: '2026/12/01',
    weekday: '火',
    reason: '昼に予定あり・夜は空き・対象',
    year: 2026,
    month: 12,
    day: 1,
    startTime: '21:00'
  });
  assert.equal(result.dates[1].startTime, '13:00');
  assert.equal(result.debugDates.length, 3);
  assert.equal(result.targetCalendarCount, 1);
  assert.deepEqual(result.targetCalendars, ['架空カレンダー']);
});


test('時間帯の端で接するだけの予定は重ならない', () => {
  const date = '2026-12-01';

  assert.equal(reasonOf(date, [timed(date, '12:00', '13:00')]), '昼・夜ともに空き・対象');
  assert.equal(reasonOf(date, [timed(date, '18:00', '19:00')]), '昼・夜ともに空き・対象');
  assert.equal(reasonOf(date, [timed(date, '12:30', '13:01')]), '昼に予定あり・夜は空き・対象');
});


test('夜の終了 24:00 は翌日 00:00 まで', () => {
  assert.equal(
    reasonOf('2026-12-01', [timed('2026-12-01', '23:30', '23:45')]),
    '昼は空き・夜に予定あり・対象'
  );
  assert.equal(
    reasonOf('2026-12-01', [timed('2026-12-02', '00:00', '01:00')]),
    '昼・夜ともに空き・対象'
  );
});


test('日付をまたぐ時間指定の予定は両日で判定する', () => {
  const event = {
    summary: '架空の夜行',
    start: { dateTime: local('2026-12-01', '22:00') },
    end: { dateTime: local('2026-12-02', '14:00') }
  };
  const result = search('2026-12-01', '2026-12-02', [event]);

  assert.equal(result.debugDates[0].reason, '昼は空き・夜に予定あり・対象');
  assert.equal(result.debugDates[1].reason, '昼に予定あり・夜は空き・対象');
});


test('複数日の終日予定は end.date を含まない', () => {
  const result = search('2026-12-01', '2026-12-05', [allDay('2026-12-02', '2026-12-04')]);

  assert.deepEqual(result.debugDates.map(day => day.isTarget), [true, false, false, true, true]);
});


test('検索期間の前から続く終日予定も対象外にする', () => {
  const result = search('2026-12-10', '2026-12-11', [allDay('2026-12-01', '2026-12-11')]);

  assert.deepEqual(result.debugDates.map(day => day.isTarget), [false, true]);
});


test('勤務場所は判定に使わず、デバッグにだけ出す', () => {
  const date = '2026-12-01';
  const items = [
    allDay(date, '2026-12-02', { summary: '架空のオフィス', eventType: 'workingLocation' })
  ];

  assert.equal(reasonOf(date, items), '昼・夜ともに空き・対象');

  const debug = getDayDebug(date, '13:00', '18:00', '21:00', '24:00', [], [calendar(items)]);

  assert.deepEqual(debug.events, []);
  assert.deepEqual(debug.ignoredEvents.map(event => event.note), ['勤務場所']);
});


test('誕生日はGAS版と同じく終日予定として数える', () => {
  const date = '2026-12-01';
  const items = [
    allDay(date, '2026-12-02', {
      summary: '架空の誕生日',
      eventType: 'birthday',
      transparency: 'transparent'
    })
  ];

  assert.equal(reasonOf(date, items), '終日予定あり・対象外');

  const debug = getDayDebug(date, '13:00', '18:00', '21:00', '24:00', [], [calendar(items)]);

  assert.deepEqual(debug.ignoredEvents, []);
  assert.deepEqual(debug.events.map(event => event.note), ['誕生日・空き時間扱い']);
});


test('不在とフォーカスタイムは予定として扱う', () => {
  const date = '2026-12-01';

  assert.equal(
    reasonOf(date, [timed(date, '14:00', '15:00', { eventType: 'focusTime' })]),
    '昼に予定あり・夜は空き・対象'
  );
  assert.equal(
    reasonOf(date, [allDay(date, '2026-12-02', { eventType: 'outOfOffice' })]),
    '終日予定あり・対象外'
  );
});


test('辞退と空き時間扱いの予定は予定として数え、デバッグに注記する', () => {
  const date = '2026-12-01';
  const items = [
    timed(date, '14:00', '15:00', { attendees: [{ self: true, responseStatus: 'declined' }] }),
    timed(date, '22:00', '23:00', { transparency: 'transparent' })
  ];

  assert.equal(reasonOf(date, items), '昼・夜ともに予定あり・対象外');

  const debug = getDayDebug(date, '13:00', '18:00', '21:00', '24:00', [], [calendar(items)]);

  assert.deepEqual(debug.events.map(event => event.note), ['辞退', '空き時間扱い']);
});


test('キャンセル済みの予定は無視する', () => {
  const date = '2026-12-01';

  assert.equal(
    reasonOf(date, [timed(date, '14:00', '15:00', { status: 'cancelled' })]),
    '昼・夜ともに空き・対象'
  );
});


test('getDayDebug の形と表示', () => {
  const date = '2026-12-01';
  const debug = getDayDebug(date, '13:00', '18:00', '21:00', '24:00', [], [
    calendar([timed(date, '14:00', '15:00', { summary: undefined })])
  ]);

  assert.deepEqual(debug, {
    date: '2026/12/01',
    weekday: '火',
    isTarget: true,
    reason: '昼に予定あり・夜は空き・対象',
    hasAllDayEvent: false,
    hasDaytimeEvent: true,
    hasNighttimeEvent: false,
    targetCalendars: ['架空カレンダー'],
    events: [{
      calendar: '架空カレンダー',
      title: '',
      allDay: false,
      time: '2026/12/01 14:00〜2026/12/01 15:00'
    }],
    daytimeEvents: [{
      calendar: '架空カレンダー',
      title: '',
      allDay: false,
      time: '2026/12/01 14:00〜2026/12/01 15:00'
    }],
    nighttimeEvents: [],
    ignoredEvents: []
  });
});


test('除外したカレンダーの予定は判定に使わない', () => {
  const date = '2026-12-01';
  const calendars = [
    calendar([allDay(date, '2026-12-02')], 'cal-a', 'A'),
    calendar([], 'cal-b', 'B')
  ];
  const result = getProposedDates(
    date, date, '13:00', '18:00', '21:00', '24:00', ['cal-a'], calendars
  );

  assert.equal(result.dates.length, 1);
  assert.deepEqual(result.targetCalendars, ['B']);
});


test('入力チェックの文言', () => {
  const run = (start, end, times = ['13:00', '18:00', '21:00', '24:00']) =>
    () => getProposedDates(start, end, ...times, [], []);

  assert.throws(run('2026/12/01', '2026-12-02'), { message: '開始日または終了日の形式が正しくありません。' });
  assert.throws(run('2026-12-02', '2026-12-01'), { message: '開始日は終了日以前にしてください。' });
  assert.throws(run('2026-01-01', '2026-06-30'), { message: '検索期間は最大180日です。' });
  assert.throws(run('2026-12-01', '2026-12-01', ['25:00', '18:00', '21:00', '24:00']), { message: '時間設定が正しくありません。' });
  assert.throws(run('2026-12-01', '2026-12-01', ['18:00', '13:00', '21:00', '24:00']), { message: '昼の開始時刻は終了時刻より前にしてください。' });
  assert.throws(run('2026-12-01', '2026-12-01', ['13:00', '18:00', '24:00', '21:00']), { message: '夜の開始時刻は終了時刻より前にしてください。' });
});


test('検索期間はちょうど180日まで使える（夏時間をまたいでも同じ）', () => {
  assert.equal(search('2026-01-01', '2026-06-29', []).debugDates.length, 180);
  assert.equal(search('2026-10-01', '2027-03-29', []).debugDates.length, 180);
});


test('夏時間の切り替え日でも日付が重複も欠落もしない', () => {
  const result = search('2026-03-07', '2026-03-09', []);

  assert.deepEqual(
    result.debugDates.map(day => day.date),
    ['2026/03/07', '2026/03/08', '2026/03/09']
  );
});


test('カレンダー一覧：ToDo リストを除き名前順、主カレンダーをメールとして使う', () => {
  const { calendars, primaryEmail } = normalizeCalendarList([
    { id: 'b', summary: 'いぬ' },
    { id: 'todo', summary: 'ToDo リスト' },
    { id: 'person@example.com', summary: 'あひる', primary: true },
    { id: 'c', summary: '元の名前', summaryOverride: 'うさぎ' }
  ]);

  assert.deepEqual(calendars, [
    { id: 'person@example.com', name: 'あひる' },
    { id: 'b', name: 'いぬ' },
    { id: 'c', name: 'うさぎ' }
  ]);
  assert.equal(primaryEmail, 'person@example.com');
});


test('主カレンダーがない、またはメール形式でなければ null', () => {
  assert.equal(normalizeCalendarList([{ id: 'a', summary: 'A' }]).primaryEmail, null);
  assert.equal(
    normalizeCalendarList([{ id: 'not-mail', summary: 'A', primary: true }]).primaryEmail,
    null
  );
  assert.equal(normalizeCalendarList(undefined).primaryEmail, null);
});


test('取得範囲は前後に1日広げる', () => {
  const { timeMin, timeMax } = getFetchRange('2026-12-10', '2026-12-11');

  assert.equal(timeMin, new Date(2026, 11, 9).toISOString());
  assert.equal(timeMax, new Date(2026, 11, 13).toISOString());
});


test('selectTargetCalendars は ToDo リストと除外指定を除く', () => {
  const targets = selectTargetCalendars(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 't', name: 'ToDo リスト' }],
    ['b']
  );

  assert.deepEqual(targets.map(item => item.id), ['a']);
});
