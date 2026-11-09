/**
 * Code.js を架空の CalendarApp の上で実際に動かし、core.js と結果を突き合わせる。
 *
 * ここで保証できるのは判定の移植が同じということまで。
 * CalendarApp と events.list が返す予定の違いは実機で比較する必要がある。
 * 架空の getEvents は「範囲と時間が重なる予定を返す」想定で書いている。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { getDayDebug, getProposedDates, normalizeApiEvents } from '../web/core.js';

const CODE_PATH = new URL('../src/Code.js', import.meta.url);

function seededRandom(seed) {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = value => String(value).padStart(2, '0');
const key = date =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function makeSpecs(random, baseDate, days, count) {
  const specs = [];

  for (let i = 0; i < count; i++) {
    const offset = Math.floor(random() * (days + 4)) - 2;
    const title = `架空の予定${i}`;

    if (random() < 0.12) {
      const start = new Date(baseDate);
      start.setDate(start.getDate() + offset);
      const end = new Date(start);
      end.setDate(end.getDate() + 1 + Math.floor(random() * 4));
      specs.push({ title, allDay: true, start, end });
    } else {
      const start = new Date(baseDate);
      start.setDate(start.getDate() + offset);
      start.setHours(Math.floor(random() * 24), Math.floor(random() * 2) * 30);
      const end = new Date(start.getTime() + (30 + Math.floor(random() * 16) * 30) * 60000);
      specs.push({ title, allDay: false, start, end });
    }
  }

  return specs;
}

function toFakeCalendar(id, name, specs) {
  return {
    getId: () => id,
    getName: () => name,
    getEvents: (rangeStart, rangeEnd) =>
      specs
        .filter(spec => spec.start < rangeEnd && spec.end > rangeStart)
        .map(spec => ({
          getTitle: () => spec.title,
          getStartTime: () => spec.start,
          getEndTime: () => spec.end,
          isAllDayEvent: () => spec.allDay
        }))
  };
}

function toApiItems(specs) {
  return specs.map(spec => ({
    summary: spec.title,
    start: spec.allDay ? { date: key(spec.start) } : { dateTime: spec.start.toISOString() },
    end: spec.allDay ? { date: key(spec.end) } : { dateTime: spec.end.toISOString() }
  }));
}

function loadGas(fakeCalendars) {
  const context = vm.createContext({
    CalendarApp: { getAllOwnedCalendars: () => fakeCalendars }
  });

  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), context);

  return context;
}

// 別の実行環境のオブジェクトを比較できるようにそろえる
const plain = value => JSON.parse(JSON.stringify(value));

function stripAdditions(debug) {
  const { ignoredEvents, ...rest } = plain(debug);
  return rest;
}


const SETTINGS = [
  ['13:00', '18:00', '21:00', '24:00'],
  ['09:00', '12:30', '19:00', '22:00'],
  ['21:00', '23:00', '10:00', '11:00']
];


for (const [index, times] of SETTINGS.entries()) {
  test(`Code.js と同じ結果になる（設定${index + 1}: ${times.join(' ')}）`, () => {
    const random = seededRandom(20261107 + index);
    const baseDate = new Date(2027, 2, 1);
    const days = 45;
    const startDate = key(baseDate);
    const last = new Date(baseDate);
    last.setDate(last.getDate() + days - 1);
    const endDate = key(last);

    const definitions = [
      ['cal-a', '架空A', makeSpecs(random, baseDate, days, 40)],
      ['cal-b', '架空B', makeSpecs(random, baseDate, days, 25)],
      ['cal-c', '除外する架空C', makeSpecs(random, baseDate, days, 200)],
      ['cal-todo', 'ToDo リスト', makeSpecs(random, baseDate, days, 200)]
    ];

    const gas = loadGas(
      definitions.map(([id, name, specs]) => toFakeCalendar(id, name, specs))
    );
    const calendars = definitions.map(([id, name, specs]) => ({
      id,
      name,
      events: normalizeApiEvents(toApiItems(specs))
    }));
    const excluded = ['cal-c'];

    const expected = gas.getProposedDates(startDate, endDate, ...times, excluded);
    const actual = getProposedDates(startDate, endDate, ...times, excluded, calendars);

    assert.deepEqual(plain(actual), plain(expected));
    assert.ok(expected.dates.length > 0 && expected.dates.length < days);

    for (let i = 0; i < days; i++) {
      const day = new Date(baseDate);
      day.setDate(day.getDate() + i);

      assert.deepEqual(
        stripAdditions(getDayDebug(key(day), ...times, excluded, calendars)),
        plain(gas.getDayDebug(key(day), ...times, excluded))
      );
    }
  });
}
