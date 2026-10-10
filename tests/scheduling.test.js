// Scheduling rules for habits.js. Run:  node --test tests/scheduling.test.js
// Time-zone independent; e.g.  TZ=Asia/Jerusalem node --test tests/scheduling.test.js  (or any other TZ)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../habits.js');

const H = Object.fromEntries(L.HABITS.map((h) => [h.id, L.normalizeHabit(h)]));
const D = (s) => L.parse(s);
const ymd = (d) => (d ? L.fmt(d) : null);
const marks = (pairs) => {
  const by = {};
  pairs.forEach(([ds, id]) => { (by[ds] = by[ds] || {})[id] = 1; });
  return by;
};

test('habit list: existing habits kept, new ones added with structured schedules', () => {
  const ids = L.HABITS.map((h) => h.id);
  assert.deepEqual(ids, ['gym', 'salsa', 'run', 'friends', 'reminders', 'climbing', 'protein', 'clean', 'steps', 'sleep', 'skincare']);
  assert.deepEqual(H.gym.weekdays, [0, 1, 3, 4]);
  assert.equal(H.gym.period, 'day');
  assert.equal(H.salsa.period, '2weeks');
  assert.deepEqual(H.salsa.weekdays, [2, 6]);
  assert.equal(H.climbing.period, 'month');
  assert.deepEqual(H.climbing.weekdays, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(H.skincare.period, 'day');
  assert.equal(H.skincare.kind, 'side');
  assert.equal(H.skincare.hint, 'אחרי המקלחת של הערב');
});

test('normalizeHabit: old rows without schedule fields behave exactly as before', () => {
  const h = L.normalizeHabit({ id: 'x', title: 'X', kind: 'main', weekdays: [2], sort_order: 1 });
  assert.equal(h.period, 'day');
  assert.equal(h.target, 1);
  assert.equal(h.anchor, null);
  assert.equal(L.isScheduled(h, D('2026-10-06')), true);   // Tuesday
  assert.equal(L.isScheduled(h, D('2026-10-07')), false);
});

test('daily / weekday habits: unchanged status rules', () => {
  const today = D('2026-10-10');                             // Saturday
  const by = marks([['2026-10-04', 'gym']]);
  assert.equal(L.status(H.gym, D('2026-10-04'), by, today), 'done');
  assert.equal(L.status(H.gym, D('2026-10-05'), by, today), 'miss');
  assert.equal(L.status(H.gym, D('2026-10-06'), by, today), 'na');
  assert.equal(L.status(H.skincare, today, by, today), 'pending');
  assert.equal(L.status(H.skincare, D('2026-10-11'), by, today), 'future');
});

test('biweekly salsa: 14-day windows anchored on a Sunday, stable across weeks, months and DST', () => {
  const w = L.windowOf(H.salsa, D('2026-10-10'));
  assert.equal(ymd(w.start), '2026-10-04');
  assert.equal(ymd(w.end), '2026-10-17');
  // every day of a window maps to the same window; the next one starts right after
  for (let i = 0; i < 14; i++) assert.equal(ymd(L.windowOf(H.salsa, L.addDays(D('2026-10-04'), i)).start), '2026-10-04');
  assert.equal(ymd(L.windowOf(H.salsa, D('2026-10-18')).start), '2026-10-18');
  // crosses Israel's DST change (Oct 25 2026) and a month boundary without drifting
  assert.equal(ymd(L.windowOf(H.salsa, D('2026-10-31')).end), '2026-10-31');
  assert.equal(ymd(L.windowOf(H.salsa, D('2026-11-01')).start), '2026-11-01');
  assert.equal(ymd(L.windowOf(H.salsa, D('2027-03-27')).start), '2027-03-21');   // ~6 months later, still aligned
  assert.equal(L.dayNum(L.windowOf(H.salsa, D('2027-03-27')).start) % 7, L.dayNum(D('2026-10-04')) % 7);
  // windows before the anchor work too
  assert.equal(ymd(L.windowOf(H.salsa, D('2026-09-30')).start), '2026-09-20');
});

test('biweekly salsa: Tuesday OR Saturday, never both, and not missed while Saturday is still possible', () => {
  const none = {};
  // Tue Oct 6 passed without salsa — still "upcoming", because Sat Oct 10 / Tue 13 / Sat 17 remain
  let s = L.windowState(H.salsa, D('2026-10-07'), none, D('2026-10-07'));
  assert.equal(s.state, 'upcoming');
  assert.equal(ymd(s.next), '2026-10-10');
  assert.equal(L.status(H.salsa, D('2026-10-06'), none, D('2026-10-07')), 'na');   // no miss recorded for Tuesday
  // On an allowed day it is due today
  s = L.windowState(H.salsa, D('2026-10-10'), none, D('2026-10-10'));
  assert.equal(s.state, 'due');
  assert.equal(s.lastChance, false);
  // Last allowed day of the window: last chance
  s = L.windowState(H.salsa, D('2026-10-17'), none, D('2026-10-17'));
  assert.equal(s.state, 'due');
  assert.equal(s.lastChance, true);
  assert.equal(L.status(H.salsa, D('2026-10-17'), none, D('2026-10-17')), 'pending');
  // Only after the last allowed day is it missed, and the miss is counted once
  s = L.windowState(H.salsa, D('2026-10-17'), none, D('2026-10-18'));
  assert.equal(s.state, 'missed');
  const r = L.rangeStats([H.salsa], D('2026-10-04'), D('2026-10-18'), none, D('2026-10-18'), null);
  assert.deepEqual([r.num, r.den], [0, 1]);
});

test('biweekly salsa: one completion satisfies the window; next due date is the next window', () => {
  const by = marks([['2026-10-06', 'salsa']]);           // went on Tuesday
  const s = L.windowState(H.salsa, D('2026-10-10'), by, D('2026-10-10'));
  assert.equal(s.state, 'done');
  assert.equal(s.count, 1);
  assert.equal(ymd(s.next), '2026-10-20');                 // first Tue/Sat of the next window (Oct 18–31)
  // Saturday is not counted as missed, nothing is "due" twice
  assert.equal(L.status(H.salsa, D('2026-10-17'), by, D('2026-10-20')), 'na');
  const r = L.rangeStats([H.salsa], D('2026-10-04'), D('2026-10-17'), by, D('2026-10-20'), null);
  assert.deepEqual([r.num, r.den], [1, 1]);
  // a second visit in the same window does not inflate the stats past 100%
  const twice = marks([['2026-10-06', 'salsa'], ['2026-10-10', 'salsa']]);
  const r2 = L.rangeStats([H.salsa], D('2026-10-04'), D('2026-10-17'), twice, D('2026-10-20'), null);
  assert.deepEqual([r2.num, r2.den], [1, 1]);
});

test('biweekly streak counts consecutive windows', () => {
  const by = marks([['2026-09-22', 'salsa'], ['2026-10-10', 'salsa'], ['2026-10-31', 'salsa']]);
  const st = L.habitStreak(H.salsa, D('2026-09-20'), D('2026-11-02'), by, D('2026-11-02'), null);
  assert.deepEqual([st.current, st.best], [3, 3]);
  const gap = marks([['2026-09-22', 'salsa'], ['2026-10-31', 'salsa']]);
  const st2 = L.habitStreak(H.salsa, D('2026-09-20'), D('2026-11-02'), gap, D('2026-11-02'), null);
  assert.deepEqual([st2.current, st2.best], [1, 1]);
});

test('monthly climbing: calendar month, any day, resets on the 1st without touching history', () => {
  const by = marks([['2026-10-21', 'climbing']]);
  let s = L.windowState(H.climbing, D('2026-10-10'), {}, D('2026-10-10'));
  assert.equal(s.state, 'due');                            // any day is fine
  assert.deepEqual([s.count, s.target], [0, 1]);
  assert.equal(ymd(s.last), '2026-10-31');
  s = L.windowState(H.climbing, D('2026-10-25'), by, D('2026-10-25'));
  assert.equal(s.state, 'done');
  assert.equal(ymd(s.next), '2026-11-01');                 // due again next month
  // November starts fresh; October's completion is still there
  s = L.windowState(H.climbing, D('2026-11-01'), by, D('2026-11-01'));
  assert.deepEqual([s.state, s.count], ['due', 0]);
  assert.equal(L.windowState(H.climbing, D('2026-10-01'), by, D('2026-11-01')).state, 'done');
  // not missed during the month, missed once after it
  assert.equal(L.status(H.climbing, D('2026-11-15'), {}, D('2026-11-20')), 'na');
  assert.equal(L.status(H.climbing, D('2026-11-30'), {}, D('2026-12-01')), 'miss');
  const r = L.rangeStats([H.climbing], D('2026-10-01'), D('2026-11-30'), by, D('2026-12-01'), null);
  assert.deepEqual([r.num, r.den], [1, 2]);
  // February / leap years
  assert.equal(ymd(L.windowOf(H.climbing, D('2028-02-10')).end), '2028-02-29');
});

test('weekly targets: counted per Sun–Sat week', () => {
  const h = L.normalizeHabit({ id: 'yoga', title: 'Y', kind: 'main', weekdays: [0, 1, 2, 3, 4, 5, 6], period: 'week', target: 2, sort_order: 99 });
  const by = marks([['2026-10-05', 'yoga']]);
  let s = L.windowState(h, D('2026-10-08'), by, D('2026-10-08'));
  assert.deepEqual([s.state, s.count, s.target], ['due', 1, 2]);
  s = L.windowState(h, D('2026-10-08'), marks([['2026-10-05', 'yoga'], ['2026-10-07', 'yoga']]), D('2026-10-08'));
  assert.equal(s.state, 'done');
  const r = L.rangeStats([h], D('2026-10-04'), D('2026-10-10'), by, D('2026-10-11'), null);
  assert.deepEqual([r.num, r.den], [1, 2]);                // one short = one miss, on the last day
});

test('day stats / heatmap only count periodic habits when done, or once when missed', () => {
  const all = Object.values(H);
  const today = D('2026-10-14');
  const by = marks([['2026-10-06', 'salsa'], ['2026-10-06', 'protein']]);
  const tue = L.dayStats(all, D('2026-10-06'), by, today);
  // Tuesday: 6 daily side habits (protein, clean, steps, sleep, skincare) + salsa done; no gym on Tue
  assert.equal(tue.done, 2);
  assert.equal(tue.sched, 6);
  // A plain Wednesday does not get "salsa/climbing missed" entries
  const wed = L.dayStats(all, D('2026-10-07'), by, today);
  assert.equal(wed.sched, 6);                              // gym + 5 daily side habits
});

test('week progress: everything due this week, including future days', () => {
  const day = Object.values(H).filter((h) => h.period === 'day');
  const p = L.weekProgress(day, D('2026-10-10'), marks([['2026-10-04', 'gym']]));
  // gym 4 + run 2 + friends 1 + reminders 1 + 5 daily side habits * 7 = 43
  assert.equal(p.total, 43);
  assert.equal(p.done, 1);
});

test('time zones: same answers whatever the device zone', () => {
  // dayNum is calendar-based, so a DST day (23h/25h) never shifts a window
  assert.equal(L.dayNum(D('2026-10-26')) - L.dayNum(D('2026-10-25')), 1);
  assert.equal(L.dayNum(D('2027-03-27')) - L.dayNum(D('2027-03-26')), 1);
  assert.equal(L.fmt(L.addDays(D('2026-10-24'), 2)), '2026-10-26');
});
