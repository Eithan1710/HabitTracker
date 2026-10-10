/* habits.js
 * Habit definitions + pure scheduling / statistics logic.
 * No DOM, no network. Works in the browser (window.HabitLogic) and in Node (tests).
 *
 * Conventions
 *  - Dates are local calendar days, written as "YYYY-MM-DD" (the device's own time zone).
 *  - Weekdays follow JS: 0 = Sunday ... 6 = Saturday. Weeks start on Sunday.
 *  - `byDate` is { "YYYY-MM-DD": { habitId: 1, ... } } and holds completed habits only.
 *
 * Scheduling model (stored per habit, nothing is special-cased by habit id)
 *  - period   'day'    -> one occurrence on every allowed weekday (gym Sun/Mon/Wed/Thu, daily habits)
 *             'week'   -> `target` times per calendar week (Sun–Sat), on any allowed weekday
 *             '2weeks' -> `target` times per 14-day cycle; cycles start on `anchor` (a Sunday)
 *             'month'  -> `target` times per calendar month, on any allowed weekday
 *  - weekdays the days the habit can be done on (for 'day': the days it is due)
 *  - target   how many completions a period needs (default 1)
 *  - anchor   first day of the 14-day cycle for '2weeks' (normalised to its Sunday)
 *
 * Status of a periodic habit is decided per period ("window"), not per day: it is only
 * missed once the last allowed day of its window has passed without enough completions.
 */
(function (root) {
  'use strict';

  var ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  var EVENING = '18:00–19:30';
  var PERIODS = ['day', 'week', '2weeks', 'month'];
  var DEFAULT_ANCHOR = '2026-10-04';

  /* ---------- Habits (bundled fallback; the same rows are seeded in supabase.sql) ---------- */
  var HABITS = [
    { id: 'gym', title: 'חדר כושר', kind: 'main', hint: 'לרשום את האימון ב-Hevy',
      weekdays: [0, 1, 3, 4], time_labels: { 0: EVENING, 1: EVENING, 3: EVENING, 4: EVENING }, sort_order: 1 },
    { id: 'salsa', title: 'שיעור סלסה', kind: 'main', hint: null,
      weekdays: [2, 6], time_labels: { 2: '21:30–00:00' }, sort_order: 2,
      period: '2weeks', target: 1, anchor: DEFAULT_ANCHOR },
    { id: 'run', title: 'ריצה', kind: 'main', hint: 'ריצה קלה',
      weekdays: [5, 6], time_labels: { 5: 'ערב, לפני היציאה', 6: 'ערב' }, sort_order: 3 },
    { id: 'friends', title: 'יציאה עם חברים', kind: 'main', hint: null,
      weekdays: [5], time_labels: { 5: 'ערב' }, sort_order: 4 },
    { id: 'reminders', title: 'בדיקת תזכורות בטלפון', kind: 'main', hint: 'לוודא שלא שכחתי משהו חשוב',
      weekdays: [6], time_labels: { 6: 'אחרי הריצה' }, sort_order: 5 },
    { id: 'climbing', title: 'טיפוס קירות', kind: 'main', hint: null,
      weekdays: ALL_DAYS, time_labels: {}, sort_order: 6, period: 'month', target: 1 },
    { id: 'protein', title: '120 גרם חלבון', kind: 'side', hint: null,
      weekdays: ALL_DAYS, time_labels: {}, sort_order: 7 },
    { id: 'clean', title: 'בלי שטויות', kind: 'side', hint: null,
      weekdays: ALL_DAYS, time_labels: {}, sort_order: 8 },
    { id: 'steps', title: '7,000 צעדים', kind: 'side', hint: null,
      weekdays: ALL_DAYS, time_labels: {}, sort_order: 9 },
    { id: 'sleep', title: 'שינה 7+ שעות', kind: 'side', hint: 'הלילה שעבר',
      weekdays: ALL_DAYS, time_labels: {}, sort_order: 10 },
    { id: 'skincare', title: 'טיפוח עור', kind: 'side', hint: 'אחרי המקלחת של הערב',
      weekdays: ALL_DAYS, time_labels: {}, sort_order: 11 }
  ];

  var COLORS = { gym: 'gym', salsa: 'salsa', run: 'run', friends: 'friends', reminders: 'reminders', climbing: 'climb' };
  function colorOf(h) { return COLORS[h.id] || (h.kind === 'main' ? 'gym' : 'ok'); }

  // Accepts a row from Supabase (or the bundled list) and returns a clean habit object.
  function normalizeHabit(row) {
    var period = PERIODS.indexOf(row.period) >= 0 ? row.period : 'day';
    var days = (row.weekdays && row.weekdays.length ? row.weekdays : ALL_DAYS).map(Number);
    return {
      id: String(row.id),
      title: String(row.title),
      kind: row.kind === 'side' ? 'side' : 'main',
      hint: row.hint || null,
      weekdays: days,
      time_labels: row.time_labels || {},
      sort_order: Number(row.sort_order) || 0,
      period: period,
      target: Math.max(1, Number(row.target) || 1),
      anchor: period === '2weeks' ? (row.anchor || DEFAULT_ANCHOR) : null
    };
  }

  /* ---------- Dates (local calendar days; arithmetic via the Date constructor is DST-safe) ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var p = String(s).slice(0, 10).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function weekStart(d) { return addDays(d, -d.getDay()); }
  function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function monthEnd(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
  function yearStart(d) { return new Date(d.getFullYear(), 0, 1); }
  function yearEnd(d) { return new Date(d.getFullYear(), 11, 31); }
  function maxDate(a, b) { return a.getTime() >= b.getTime() ? a : b; }
  function minDate(a, b) { return a.getTime() <= b.getTime() ? a : b; }
  // Whole-day index independent of the time zone / DST (calendar day count since 1970-01-01).
  function dayNum(d) { return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000); }
  function sameDay(a, b) { return dayNum(a) === dayNum(b); }

  /* ---------- Schedule ---------- */
  function isPeriodic(h) { return h.period && h.period !== 'day'; }
  function allows(h, d) { return h.weekdays.indexOf(d.getDay()) >= 0; }
  // A 'day' habit is due on this date (periodic habits are never "due on a date"; see windowState).
  function isScheduled(h, d) { return !isPeriodic(h) && allows(h, d); }

  // The period that contains `d` for habit `h`: { start, end } (inclusive local days).
  function windowOf(h, d) {
    if (h.period === 'week') { var ws = weekStart(d); return { start: ws, end: addDays(ws, 6) }; }
    if (h.period === 'month') return { start: monthStart(d), end: monthEnd(d) };
    if (h.period === '2weeks') {
      var a = weekStart(parse(h.anchor || DEFAULT_ANCHOR));
      var k = Math.floor((dayNum(d) - dayNum(a)) / 14);
      var s = addDays(a, k * 14);
      return { start: s, end: addDays(s, 13) };
    }
    return { start: midnight(d), end: midnight(d) };
  }
  function nextWindow(h, w) { return windowOf(h, addDays(w.end, 1)); }

  // Allowed days inside [from, to].
  function allowedDays(h, from, to) {
    var out = [];
    for (var d = from; d.getTime() <= to.getTime(); d = addDays(d, 1)) if (allows(h, d)) out.push(d);
    return out;
  }
  function lastAllowed(h, w) {
    for (var d = w.end; d.getTime() >= w.start.getTime(); d = addDays(d, -1)) if (allows(h, d)) return d;
    return w.end;
  }
  function firstAllowed(h, from, to) {
    for (var d = from; d.getTime() <= to.getTime(); d = addDays(d, 1)) if (allows(h, d)) return d;
    return null;
  }

  function doneOn(h, d, byDate) { var r = byDate[fmt(d)]; return !!(r && r[h.id]); }
  // Completion dates of `h` inside window `w`, oldest first.
  function doneDates(h, w, byDate) {
    var out = [];
    for (var d = w.start; d.getTime() <= w.end.getTime(); d = addDays(d, 1)) if (doneOn(h, d, byDate)) out.push(d);
    return out;
  }

  /* Where a periodic habit stands in the window that contains `ref`, judged as of `today`.
   *  state: 'done'     target reached
   *         'due'      not reached, and today is an allowed day inside this window
   *         'upcoming' not reached, an allowed day is still ahead (next = that day)
   *         'missed'   window is over (or no allowed day is left) without reaching the target
   *  lastChance: today is the final allowed day of the window
   *  next: the day to aim for (today when due; first allowed day of the next window when done)
   */
  function windowState(h, ref, byDate, today) {
    var w = windowOf(h, ref);
    var dates = doneDates(h, w, byDate);
    var count = dates.length, target = h.target || 1;
    var last = lastAllowed(h, w);
    var t = today.getTime();
    var res = { window: w, count: count, target: target, dates: dates, last: last, lastChance: false, next: null, state: '' };
    if (count >= target) {
      var nw = nextWindow(h, w);
      res.state = 'done';
      res.next = firstAllowed(h, nw.start, nw.end) || nw.start;
      return res;
    }
    if (w.end.getTime() < t) { res.state = 'missed'; return res; }
    if (w.start.getTime() > t) { res.state = 'upcoming'; res.next = firstAllowed(h, w.start, w.end); return res; }
    // today is inside the window
    if (allows(h, today)) { res.state = 'due'; res.next = today; res.lastChance = sameDay(today, last); return res; }
    var ahead = firstAllowed(h, addDays(today, 1), w.end);
    if (ahead) { res.state = 'upcoming'; res.next = ahead; return res; }
    res.state = 'missed';
    return res;
  }

  /* ---------- Status of one habit on one day (drives every history statistic) ----------
   * 'na' nothing to count | 'done' | 'miss' (past, not done) | 'pending' (today, not yet) | 'future'
   * Periodic habits count on the days they were done (up to `target` per window), and a
   * shortfall counts once, on the window's last allowed day — never earlier.
   */
  function occ(h, d, byDate, today) {
    if (!isPeriodic(h)) {
      if (!allows(h, d)) return { st: 'na', done: 0, miss: 0 };
      if (doneOn(h, d, byDate)) return { st: 'done', done: 1, miss: 0 };
      var diff = d.getTime() - today.getTime();
      return diff < 0 ? { st: 'miss', done: 0, miss: 1 } : { st: diff === 0 ? 'pending' : 'future', done: 0, miss: 0, open: diff === 0 ? 1 : 0 };
    }
    var w = windowOf(h, d), target = h.target || 1;
    if (doneOn(h, d, byDate)) {
      var before = 0;
      for (var x = w.start; x.getTime() < d.getTime(); x = addDays(x, 1)) if (doneOn(h, x, byDate)) before++;
      return before < target ? { st: 'done', done: 1, miss: 0 } : { st: 'na', done: 0, miss: 0 };
    }
    if (!sameDay(d, lastAllowed(h, w))) return { st: 'na', done: 0, miss: 0 };
    var short = target - Math.min(target, doneDates(h, w, byDate).length);
    if (!short) return { st: 'na', done: 0, miss: 0 };
    var df = d.getTime() - today.getTime();
    if (df < 0) return { st: 'miss', done: 0, miss: short };
    return { st: df === 0 ? 'pending' : 'future', done: 0, miss: 0, open: df === 0 ? short : 0 };
  }
  function status(h, d, byDate, today) { return occ(h, d, byDate, today).st; }

  // Completion of a set of habits on one day (today's pending items count as not done yet).
  function dayStats(habits, d, byDate, today) {
    var sched = 0, done = 0;
    for (var i = 0; i < habits.length; i++) {
      var o = occ(habits[i], d, byDate, today);
      if (o.st === 'na' || o.st === 'future') continue;
      done += o.done;
      sched += o.done + o.miss + (o.open || 0);
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
        var o = occ(habits[i], d, byDate, today);
        num += o.done; den += o.done + o.miss;
      }
    }
    return { num: num, den: den, pct: den ? num / den : null };
  }

  // Streak of consecutive occurrences done (for periodic habits: consecutive periods met).
  // A pending/future day never breaks it.
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

  // Streak of "perfect days": every occurrence counted that day (in the given set) is done.
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

  // Heatmap intensity: -1 no data / nothing scheduled, 0 nothing done, 1..4 growing share done.
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

  // Summary of any calendar period [from, to] (neutral facts only).
  function periodOverview(habits, from, to, byDate, today, start) {
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
    return { avg: total.pct, num: total.num, den: total.den, days: best, top: top };
  }

  function monthOverview(habits, monthDate, byDate, today, start) {
    return periodOverview(habits, monthStart(monthDate), monthEnd(monthDate), byDate, today, start);
  }

  // Forward-looking progress for the week containing `ref`: everything due this week
  // (day habits on their days + weekly targets), not only what has passed so far.
  function weekProgress(habits, ref, byDate) {
    var ws = weekStart(ref), we = addDays(ws, 6), total = 0, done = 0;
    habits.forEach(function (h) {
      if (h.period === 'day') {
        allowedDays(h, ws, we).forEach(function (d) { total++; if (doneOn(h, d, byDate)) done++; });
      } else if (h.period === 'week') {
        total += h.target; done += Math.min(h.target, doneDates(h, { start: ws, end: we }, byDate).length);
      }
    });
    return { done: done, total: total };
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

  // Completion of a set of habits per bucket (day / week / month).
  function groupSeries(habits, from, to, unit, byDate, today, start) {
    var last = minDate(to, today);
    return buckets(from, last, unit).map(function (b) {
      var r = rangeStats(habits, b.start, b.end, byDate, today, start);
      return { start: b.start, end: b.end, num: r.num, den: r.den, pct: r.pct };
    });
  }

  function series(h, from, to, unit, byDate, today, start) {
    return groupSeries([h], from, to, unit, byDate, today, start);
  }

  var api = {
    HABITS: HABITS, ALL_DAYS: ALL_DAYS, PERIODS: PERIODS, colorOf: colorOf, normalizeHabit: normalizeHabit,
    fmt: fmt, parse: parse, midnight: midnight, addDays: addDays, weekStart: weekStart, dayNum: dayNum, sameDay: sameDay,
    monthStart: monthStart, monthEnd: monthEnd, yearStart: yearStart, yearEnd: yearEnd, maxDate: maxDate, minDate: minDate,
    isPeriodic: isPeriodic, allows: allows, isScheduled: isScheduled, windowOf: windowOf, nextWindow: nextWindow,
    lastAllowed: lastAllowed, firstAllowed: firstAllowed, allowedDays: allowedDays, doneDates: doneDates, windowState: windowState,
    occ: occ, status: status, dayStats: dayStats, rangeStats: rangeStats, weekProgress: weekProgress,
    habitStreak: habitStreak, perfectDayStreak: perfectDayStreak, totalDone: totalDone,
    level: level, habitRates: habitRates, periodOverview: periodOverview, monthOverview: monthOverview,
    buckets: buckets, series: series, groupSeries: groupSeries
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HabitLogic = api;
})(typeof window !== 'undefined' ? window : this);
