/* habits.js
 * Habit definitions (identical to the existing tracker) + pure date/statistics logic.
 * No DOM, no network. Works in the browser (window.HabitLogic) and in Node (tests).
 *
 * Conventions
 *  - Dates are local calendar days, written as "YYYY-MM-DD".
 *  - Weekdays follow JS: 0 = Sunday ... 6 = Saturday.
 *  - `byDate` is { "YYYY-MM-DD": { habitId: 1, ... } } and holds completed habits only.
 */
(function (root) {
  'use strict';

  var ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  var EVENING = '18:00–19:30';

  /* ---------- Habits (bundled fallback; the same rows are seeded in supabase.sql) ---------- */
  var HABITS = [
    { id: 'gym', title: 'חדר כושר', kind: 'main', hint: 'לרשום את האימון ב-Hevy',
      weekdays: [0, 1, 3, 4], time_labels: { 0: EVENING, 1: EVENING, 3: EVENING, 4: EVENING }, sort_order: 1 },
    { id: 'salsa', title: 'שיעור סלסה', kind: 'main', hint: null,
      weekdays: [2], time_labels: { 2: '21:30–00:00' }, sort_order: 2 },
    { id: 'run', title: 'ריצה', kind: 'main', hint: 'ריצה קלה',
      weekdays: [5, 6], time_labels: { 5: 'ערב, לפני היציאה', 6: 'ערב' }, sort_order: 3 },
    { id: 'friends', title: 'יציאה עם חברים', kind: 'main', hint: null,
      weekdays: [5], time_labels: { 5: 'ערב' }, sort_order: 4 },
    { id: 'reminders', title: 'בדיקת תזכורות בטלפון', kind: 'main', hint: 'לוודא שלא שכחתי משהו חשוב',
      weekdays: [6], time_labels: { 6: 'אחרי הריצה' }, sort_order: 5 },
    { id: 'protein', title: '120 גרם חלבון', kind: 'side', hint: null,
      weekdays: ALL_DAYS, time_labels: {}, sort_order: 6 },
    { id: 'clean', title: 'בלי שטויות', kind: 'side', hint: null,
      weekdays: ALL_DAYS, time_labels: {}, sort_order: 7 },
    { id: 'steps', title: '7,000 צעדים', kind: 'side', hint: null,
      weekdays: ALL_DAYS, time_labels: {}, sort_order: 8 },
    { id: 'sleep', title: 'שינה 7+ שעות', kind: 'side', hint: 'הלילה שעבר',
      weekdays: ALL_DAYS, time_labels: {}, sort_order: 9 }
  ];

  var COLORS = { gym: 'gym', salsa: 'salsa', run: 'run', friends: 'friends', reminders: 'reminders' };
  function colorOf(h) { return COLORS[h.id] || (h.kind === 'main' ? 'gym' : 'ok'); }

  // Accepts a row from Supabase (or the bundled list) and returns a clean habit object.
  function normalizeHabit(row) {
    return {
      id: String(row.id),
      title: String(row.title),
      kind: row.kind === 'side' ? 'side' : 'main',
      hint: row.hint || null,
      weekdays: (row.weekdays || ALL_DAYS).map(Number),
      time_labels: row.time_labels || {},
      sort_order: Number(row.sort_order) || 0
    };
  }

  /* ---------- Dates ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function weekStart(d) { return addDays(d, -d.getDay()); }
  function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function monthEnd(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
  function maxDate(a, b) { return a.getTime() >= b.getTime() ? a : b; }
  function minDate(a, b) { return a.getTime() <= b.getTime() ? a : b; }

  /* ---------- Status of one habit on one day ---------- */
  // 'na' not scheduled | 'done' | 'miss' (past, not done) | 'pending' (today, not yet) | 'future'
  function isScheduled(h, d) { return h.weekdays.indexOf(d.getDay()) >= 0; }
  function status(h, d, byDate, today) {
    if (!isScheduled(h, d)) return 'na';
    var row = byDate[fmt(d)];
    if (row && row[h.id]) return 'done';
    var diff = d.getTime() - today.getTime();
    return diff < 0 ? 'miss' : diff === 0 ? 'pending' : 'future';
  }

  // Completion of a set of habits on one day (today's pending items count as not done).
  function dayStats(habits, d, byDate, today) {
    var sched = 0, done = 0;
    for (var i = 0; i < habits.length; i++) {
      var st = status(habits[i], d, byDate, today);
      if (st === 'na') continue;
      sched++;
      if (st === 'done') done++;
    }
    return { sched: sched, done: done, pct: sched ? done / sched : null };
  }

  /* ---------- Aggregates ---------- */
  // Rule: an occurrence counts if it is in the past, or it is today and already done.
  // `start` (Date|null) clips the range to the first day that has any data.
  function rangeStats(habits, from, to, byDate, today, start) {
    var a = start ? maxDate(from, start) : from;
    var b = minDate(to, today);
    var num = 0, den = 0;
    for (var d = a; d.getTime() <= b.getTime(); d = addDays(d, 1)) {
      for (var i = 0; i < habits.length; i++) {
        var st = status(habits[i], d, byDate, today);
        if (st === 'done') { num++; den++; }
        else if (st === 'miss') { den++; }
      }
    }
    return { num: num, den: den, pct: den ? num / den : null };
  }

  // Streak of consecutive scheduled occurrences done. A pending/future day never breaks it.
  function habitStreak(h, from, to, byDate, today, start) {
    var a = start ? maxDate(from, start) : from;
    var b = minDate(to, today);
    var run = 0, best = 0;
    for (var d = a; d.getTime() <= b.getTime(); d = addDays(d, 1)) {
      var st = status(h, d, byDate, today);
      if (st === 'done') { run++; if (run > best) best = run; }
      else if (st === 'miss') { run = 0; }
    }
    return { current: run, best: best };
  }

  // Streak of "perfect days": every habit scheduled that day (in the given set) is done.
  function perfectDayStreak(habits, from, to, byDate, today, start) {
    var a = start ? maxDate(from, start) : from;
    var b = minDate(to, today);
    var run = 0, best = 0;
    for (var d = a; d.getTime() <= b.getTime(); d = addDays(d, 1)) {
      var s = dayStats(habits, d, byDate, today);
      if (!s.sched) continue;
      if (s.done === s.sched) { run++; if (run > best) best = run; }
      else if (d.getTime() < today.getTime()) { run = 0; }
    }
    return { current: run, best: best };
  }

  function totalDone(habits, byDate) {
    var ids = {}, n = 0;
    habits.forEach(function (h) { ids[h.id] = 1; });
    Object.keys(byDate).forEach(function (k) {
      Object.keys(byDate[k]).forEach(function (id) { if (ids[id] && byDate[k][id]) n++; });
    });
    return n;
  }

  // Heatmap intensity: -1 no data / not scheduled, 0 nothing done, 1..4 growing share done.
  function level(pct) {
    if (pct === null) return -1;
    if (pct === 0) return 0;
    if (pct < 0.34) return 1;
    if (pct < 0.67) return 2;
    if (pct < 1) return 3;
    return 4;
  }

  // Completion rate per habit, lowest first.
  function habitRates(habits, from, to, byDate, today, start) {
    return habits.map(function (h) {
      var r = rangeStats([h], from, to, byDate, today, start);
      return { habit: h, num: r.num, den: r.den, pct: r.pct };
    }).filter(function (r) { return r.den > 0; }).sort(function (x, y) {
      return x.pct - y.pct || y.den - x.den || x.habit.sort_order - y.habit.sort_order;
    });
  }

  // Calendar month summary (neutral facts only).
  function monthOverview(habits, monthDate, byDate, today, start) {
    var from = monthStart(monthDate), to = monthEnd(monthDate);
    var total = rangeStats(habits, from, to, byDate, today, start);
    var best = null;
    var a = start ? maxDate(from, start) : from;
    var b = minDate(to, today);
    for (var d = a; d.getTime() <= b.getTime(); d = addDays(d, 1)) {
      var s = dayStats(habits, d, byDate, today);
      if (!s.sched) continue;
      if (!best || s.pct > best.pct || (s.pct === best.pct && s.done >= best.done)) {
        best = { date: d, done: s.done, sched: s.sched, pct: s.pct };
      }
    }
    var rates = habitRates(habits, from, to, byDate, today, start);
    var top = rates.length ? rates[rates.length - 1] : null;
    return { avg: total.pct, days: best, top: top };
  }

  /* ---------- Chart buckets ---------- */
  function buckets(from, to, unit) {
    var out = [];
    var d, e;
    if (unit === 'day') {
      for (d = from; d.getTime() <= to.getTime(); d = addDays(d, 1)) out.push({ start: d, end: d });
    } else if (unit === 'week') {
      for (d = weekStart(from); d.getTime() <= to.getTime(); d = addDays(d, 7)) {
        out.push({ start: maxDate(d, from), end: minDate(addDays(d, 6), to) });
      }
    } else {
      for (d = monthStart(from); d.getTime() <= to.getTime(); d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
        e = monthEnd(d);
        out.push({ start: maxDate(d, from), end: minDate(e, to) });
      }
    }
    return out;
  }

  function series(h, from, to, unit, byDate, today, start) {
    var last = minDate(to, today);
    return buckets(from, last, unit).map(function (b) {
      var r = rangeStats([h], b.start, b.end, byDate, today, start);
      return { start: b.start, end: b.end, num: r.num, den: r.den, pct: r.pct };
    });
  }

  var api = {
    HABITS: HABITS, ALL_DAYS: ALL_DAYS, colorOf: colorOf, normalizeHabit: normalizeHabit,
    fmt: fmt, parse: parse, midnight: midnight, addDays: addDays, weekStart: weekStart,
    monthStart: monthStart, monthEnd: monthEnd, maxDate: maxDate, minDate: minDate,
    isScheduled: isScheduled, status: status, dayStats: dayStats, rangeStats: rangeStats,
    habitStreak: habitStreak, perfectDayStreak: perfectDayStreak, totalDone: totalDone,
    level: level, habitRates: habitRates, monthOverview: monthOverview,
    buckets: buckets, series: series
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HabitLogic = api;
})(typeof window !== 'undefined' ? window : this);
