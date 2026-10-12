/* app.js — Habit tracker UI + Supabase sync.
 * Local-first: every tap updates the screen and localStorage immediately, then a
 * background queue upserts to Supabase (and retries when the connection returns).
 */
(function () {
  'use strict';

  var L = window.HabitLogic;
  var CFG = window.HABITS_CONFIG || {};
  var SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
  var KEY = { habits: 'hb:v2:habits', done: 'hb:v1:done', pending: 'hb:v1:pending', first: 'hb:v1:first', period: 'hb:v1:period' };
  var LETTER = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
  var CONFIGURED = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

  /* ------------------------------------------------------------------ helpers */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function load(key, fallback) {
    try { var r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch (e) { return fallback; }
  }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function pctText(p) { return p === null || p === undefined ? '—' : Math.round(p * 100) + '%'; }
  function dateText(d, opts) { try { return d.toLocaleDateString('he-IL', opts); } catch (e) { return L.fmt(d); } }
  function num(n) { try { return n.toLocaleString('he-IL'); } catch (e) { return String(n); } }
  function bySort(a, b) { return a.sort_order - b.sort_order; }
  function reduceMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

  /* ------------------------------------------------------------------ state */
  var cachedHabits = load(KEY.habits, null);
  var S = {
    habits: (Array.isArray(cachedHabits) && cachedHabits.length ? cachedHabits : L.HABITS).map(L.normalizeHabit).sort(bySort),
    byDate: load(KEY.done, {}),
    pending: load(KEY.pending, {}),
    first: load(KEY.first, null),
    firstChecked: false,
    sb: null,
    today: L.midnight(new Date()),
    viewDate: L.midnight(new Date()),
    tab: 'today',
    hTab: 'overview',
    scope: 'main',
    hHabit: 'gym',
    hRange: '30',
    period: load(KEY.period, 'month'),
    weekStart: L.weekStart(L.midnight(new Date())),
    monthRef: L.monthStart(new Date()),
    yearRef: L.yearStart(new Date()),
    loadedFrom: null,
    loadedAt: 0,
    totals: {}
  };
  S.hHabit = (S.habits[0] || {}).id || 'gym';
  if (['week', 'month', 'year'].indexOf(S.period) < 0) S.period = 'month';

  function habitsFor(d) { return S.habits.filter(function (h) { return L.isScheduled(h, d); }).sort(bySort); }
  function scopeHabits() { return S.habits.filter(function (h) { return S.scope === 'all' || h.kind === S.scope; }); }
  function habitById(id) { for (var i = 0; i < S.habits.length; i++) if (S.habits[i].id === id) return S.habits[i]; return S.habits[0]; }

  // Earliest day we know has data: server's first record, or anything cached/pending locally.
  function startDate() {
    var c = [];
    if (S.first) c.push(S.first);
    Object.keys(S.byDate).forEach(function (k) { c.push(k); });
    Object.keys(S.pending).forEach(function (k) { c.push(S.pending[k].date); });
    if (!c.length) return null;
    c.sort();
    return L.parse(c[0]);
  }

  function persistDone() { save(KEY.done, S.byDate); }
  function persistPending() { save(KEY.pending, S.pending); }

  /* ------------------------------------------------------------------ data mutation (optimistic) */
  function markLocal(ds, id, on) {
    var row = S.byDate[ds] || (S.byDate[ds] = {});
    if (on) row[id] = 1; else delete row[id];
    if (!Object.keys(row).length) delete S.byDate[ds];
  }
  function enqueue(ds, id, on) {
    S.pending[ds + '|' + id] = { date: ds, habit_id: id, completed: !!on, ts: Date.now() };
  }
  function setDone(ds, id, on) {
    markLocal(ds, id, on);
    enqueue(ds, id, on);
    persistDone();
    persistPending();
    scheduleFlush(250);
  }

  /* ------------------------------------------------------------------ Supabase sync */
  function loadScript(src, ms) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      s.src = src; s.async = true;
      s.onload = function () { clearTimeout(t); resolve(); };
      s.onerror = function () { clearTimeout(t); reject(new Error('load')); };
      document.head.appendChild(s);
    });
  }
  function canSync() { return !!S.sb; }

  var flushing = false, flushTimer = null, retryTimer = null, backoff = 4000;
  function scheduleFlush(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms); }

  async function flush() {
    if (flushing || !canSync()) { return; }
    var keys = Object.keys(S.pending);
    if (!keys.length) { return; }
    flushing = true;
    var batch = keys.slice(0, 300).map(function (k) { return S.pending[k]; });
    var rows = batch.map(function (op) {
      return { habit_id: op.habit_id, date: op.date, completed: op.completed };
    });
    try {
      var r = await S.sb.from('completions').upsert(rows, { onConflict: 'habit_id,date' });
      if (r.error) throw r.error;
      batch.forEach(function (op) {
        var k = op.date + '|' + op.habit_id;
        if (S.pending[k] && S.pending[k].ts === op.ts) delete S.pending[k];
      });
      persistPending();
      backoff = 4000;
      flushing = false;
      if (Object.keys(S.pending).length) return flush();
    } catch (e) {
      flushing = false;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(flush, backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }

  async function fetchRange(from, to) {
    var out = [], page = 0, size = 1000;
    for (;;) {
      var r = await S.sb.from('completions').select('habit_id,date')
        .eq('completed', true).gte('date', from).lte('date', to)
        .order('date').order('habit_id').range(page * size, page * size + size - 1);
      if (r.error) throw r.error;
      out = out.concat(r.data || []);
      if (!r.data || r.data.length < size) break;
      page++;
    }
    return out;
  }

  // Server is the source of truth for [from, to]; unsent local changes are laid on top.
  function applyServer(from, to, rows) {
    Object.keys(S.byDate).forEach(function (k) { if (k >= from && k <= to) delete S.byDate[k]; });
    rows.forEach(function (r) { (S.byDate[r.date] = S.byDate[r.date] || {})[r.habit_id] = 1; });
    Object.keys(S.pending).forEach(function (k) {
      var op = S.pending[k];
      if (op.date >= from && op.date <= to) markLocal(op.date, op.habit_id, op.completed);
    });
    persistDone();
  }

  async function ensureFirst() {
    if (!canSync() || S.firstChecked) return;
    try {
      var r = await S.sb.from('completions').select('date').order('date', { ascending: true }).limit(1);
      if (!r.error) {
        S.firstChecked = true;
        if (r.data && r.data.length) { S.first = r.data[0].date; save(KEY.first, S.first); }
      }
    } catch (e) {}
  }

  // Loads history from `fromStr` up to today, only what is not already loaded/fresh.
  async function ensureData(fromStr) {
    if (!canSync()) return;
    var fresh = !!S.loadedFrom && (Date.now() - S.loadedAt) < 60000;
    if (fresh && fromStr >= S.loadedFrom) return;
    try {
      var start = fresh ? fromStr : (S.loadedFrom && S.loadedFrom < fromStr ? S.loadedFrom : fromStr);
      var end = fresh ? L.fmt(L.addDays(L.parse(S.loadedFrom), -1)) : L.fmt(S.today);
      var rows = await fetchRange(start, end);
      applyServer(start, end, rows);
      S.loadedFrom = (S.loadedFrom && S.loadedFrom < start) ? S.loadedFrom : start;
      if (!fresh) S.loadedAt = Date.now();
    } catch (e) { /* offline: keep cache */ }
  }

  async function fetchTotal(ids) {
    if (!canSync()) return null;
    try {
      var r = await S.sb.from('completions').select('habit_id', { count: 'exact', head: true })
        .eq('completed', true).in('habit_id', ids);
      return r.error ? null : r.count;
    } catch (e) { return null; }
  }

  async function refreshHabits() {
    if (!canSync()) return;
    try {
      var r = await S.sb.from('habits').select('id,title,kind,hint,weekdays,time_labels,sort_order,period,target,anchor').order('sort_order');
      // Older databases without the schedule columns error here: keep the bundled definitions.
      if (r.error || !r.data || !r.data.length) return;
      S.habits = r.data.map(L.normalizeHabit).sort(bySort);
      save(KEY.habits, r.data);
      if (S.tab === 'today') renderToday();
    } catch (e) {}
  }

  // Today needs the viewed week (week strip) and the viewed month (monthly goals, 2-week window).
  function todayFrom(d) {
    return L.fmt(L.minDate(L.minDate(L.weekStart(d), L.monthStart(d)), L.addDays(L.weekStart(d), -7)));
  }

  function bootSync() {
    refreshHabits();
    flush().then(function () { return ensureData(todayFrom(S.viewDate)); }).then(function () {
      if (S.tab === 'today') renderToday();
    });
    ensureFirst();
    syncPush();
  }

  /* ------------------------------------------------------------------ connection (no login) */
  var initing = false;
  async function initSupabase() {
    if (!CONFIGURED || initing || S.sb) { return; }
    initing = true;
    try {
      try { await loadScript(SDK_URL, 9000); } catch (e) { return; }
      if (!window.supabase || !window.supabase.createClient) return;
      S.sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      });
      bootSync();
    } finally {
      initing = false;
    }
  }


  /* ------------------------------------------------------------------ daily 22:00 reminder (Web Push) */
  // One-time opt-in card on the Today screen. Once allowed, the card disappears and the
  // subscription is silently re-saved on every launch (browsers can rotate it).
  var VAPID = CFG.VAPID_PUBLIC_KEY || '';
  var REMIND_HIDE = 'hb:v1:remind-hide';
  var IS_IOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var STANDALONE = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  function pushSupported() { return !!VAPID && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function b64ToBytes(b64) {
    var pad = '='.repeat((4 - b64.length % 4) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  var BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';

  function remindState() {
    if (!VAPID || load(REMIND_HIDE, false)) return null;
    if (pushSupported()) return Notification.permission === 'default' ? 'ask' : null;
    if (IS_IOS && !STANDALONE) return 'ios';   // iPhone: push only works from the home-screen app
    return null;
  }
  function paintRemind(msg) {
    var box = $('remind');
    if (!box) return;
    if (msg) { box.innerHTML = '<div class="remind done">' + BELL + '<span class="rmd-t"><b>' + esc(msg) + '</b></span></div>'; return; }
    var st = S.viewDate.getTime() === S.today.getTime() ? remindState() : null;
    if (!st) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="remind">' + BELL +
      '<span class="rmd-t"><b>תזכורת ערב ב-22:00</b><span>' +
        (st === 'ios' ? 'כדי לקבל התראות, הוסף את האתר למסך הבית (שיתוף ← הוספה למסך הבית) ופתח משם.' : 'רק אם נשארו הרגלים לסמן.') +
      '</span></span>' +
      (st === 'ask' ? '<button type="button" class="pill" data-act="remind-on">הפעלה</button>' : '') +
      '<button type="button" class="ic sm x" data-act="remind-x" aria-label="לא עכשיו"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>' +
      '</div>';
  }

  async function savePushSub(sub) {
    if (!canSync() || !sub) return false;
    var j = sub.toJSON();
    if (!j.keys || !j.keys.p256dh || !j.keys.auth) return false;
    try {
      var r = await S.sb.rpc('save_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
      return !r.error;
    } catch (e) { return false; }
  }
  async function getPushSub(create) {
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID) });
    return sub;
  }
  // Called after Supabase connects: keep an already-granted subscription saved on the server.
  async function syncPush() {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    try { await savePushSub(await getPushSub(true)); } catch (e) {}
  }
  async function enableRemind() {
    try {
      var perm = await Notification.requestPermission();
      if (perm !== 'granted') { paintRemind(); return; }
      var sub = await getPushSub(true);
      if (!S.sb) await initSupabase();
      await savePushSub(sub);
      paintRemind('התזכורת הופעלה · כל ערב ב-22:00');
      setTimeout(function () { paintRemind(); }, 2600);
    } catch (e) { paintRemind(); }
  }

  /* ------------------------------------------------------------------ navigation */
  // Sync runs silently: no status text, no badges, nothing for the user to manage.
  function go(tab) {
    S.tab = tab;
    ['today', 'history'].forEach(function (t) {
      $('view-' + t).hidden = t !== tab;
      $('nav-' + t).setAttribute('aria-current', t === tab ? 'page' : 'false');
    });
    if (tab === 'today') renderToday();
    if (tab === 'history') renderHistory();
    window.scrollTo(0, 0);
  }
  ['today', 'history'].forEach(function (t) {
    $('nav-' + t).addEventListener('click', function () { go(t); });
  });

  /* ------------------------------------------------------------------ TODAY */
  var CHECK = '<span class="chk" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg></span>';
  var CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';

  var DAY_NAME = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  var PERIOD_WORD = { week: 'השבוע', '2weeks': 'בשבועיים האלה', month: 'החודש' };
  var GROUP_TITLE = { week: 'השבוע', '2weeks': 'כל שבועיים', month: 'החודש' };

  function shortDate(d) { return d.getDate() + '.' + (d.getMonth() + 1); }
  // "היום" / "מחר" / "אתמול" / "שלישי 13.10" — relative to the real today.
  function whenText(d) {
    var n = L.dayNum(d) - L.dayNum(S.today);
    if (n === 0) return 'היום';
    if (n === 1) return 'מחר';
    if (n === -1) return 'אתמול';
    return DAY_NAME[d.getDay()] + ' ' + shortDate(d);
  }
  function daysText(h) {
    if (h.weekdays.length === 7) return 'באיזה יום שנוח';
    var names = h.weekdays.slice().sort().map(function (i) { return DAY_NAME[i]; });
    return names.length === 1 ? 'ב' + names[0] : names.slice(0, -1).join(', ') + ' או ' + names[names.length - 1];
  }
  function freqText(h) {
    var t = h.target || 1;
    if (h.period === 'week') return t === 1 ? 'פעם בשבוע' : t + ' פעמים בשבוע';
    if (h.period === '2weeks') return t === 1 ? 'כל שבועיים' : t + ' פעמים בשבועיים';
    if (h.period === 'month') return t === 1 ? 'פעם בחודש' : t + ' פעמים בחודש';
    return h.weekdays.length === 7 ? 'כל יום' : h.weekdays.slice().sort().map(function (i) { return LETTER[i]; }).join(' ');
  }
  function periodicHabits() { return S.habits.filter(L.isPeriodic).sort(bySort); }

  // Main habit: a full-width row. Time + hint sit under the title, quiet.
  function rowHTML(h, d) {
    var tl = h.time_labels && h.time_labels[d.getDay()];
    var meta = '';
    if (tl) meta += '<span class="chip"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>' + esc(tl) + '</span>';
    if (h.hint) meta += '<span class="hint">' + esc(h.hint) + '</span>';
    return '<button type="button" class="row main" data-id="' + esc(h.id) + '" aria-pressed="false" style="--c:var(--' + L.colorOf(h) + ')">' +
      CHECK + '<span class="rt"><b>' + esc(h.title) + '</b>' + (meta ? '<span class="rm">' + meta + '</span>' : '') + '</span></button>';
  }

  // Side habit: a compact tile, two per row on a phone.
  function tileHTML(h) {
    return '<button type="button" class="tile" data-id="' + esc(h.id) + '" aria-pressed="false" style="--c:var(--' + L.colorOf(h) + ')">' +
      CHECK + '<span class="tt"><b>' + esc(h.title) + '</b>' + (h.hint ? '<span>' + esc(h.hint) + '</span>' : '') + '</span></button>';
  }

  // Periodic habit (every 2 weeks / monthly / weekly): one card that shows the whole period.
  function goalHTML(h, d) {
    var tl = h.time_labels && h.time_labels[d.getDay()];
    return '<button type="button" class="goal" data-goal="' + esc(h.id) + '" aria-pressed="false" style="--c:var(--' + L.colorOf(h) + ')">' +
      CHECK +
      '<span class="gt"><b>' + esc(h.title) + '</b>' +
        '<span class="gm">' + esc(freqText(h)) + ' · ' + esc(daysText(h)) + (tl ? ' · ' + esc(tl) : '') + '</span>' +
        '<span class="gp"><span class="segs" aria-hidden="true"></span><span class="gp-t"></span></span>' +
        '<span class="gl"></span>' +
      '</span>' +
      '<span class="gs"></span>' +
    '</button>';
  }

  // State line for a goal card, as of the real today, for the period that contains the viewed day.
  function goalView(h) {
    var ws = L.windowState(h, S.viewDate, S.byDate, S.today);
    var lastDone = ws.dates.length ? ws.dates[ws.dates.length - 1] : null;
    var v = { ws: ws, cls: ws.state, badge: '', line: '' };
    var past = ws.window.end.getTime() < S.today.getTime();   // browsing an earlier period
    if (ws.state === 'done') {
      v.badge = 'בוצע';
      var rel = L.dayNum(lastDone) - L.dayNum(S.today) >= -1;
      v.line = (rel ? 'בוצע ' : 'בוצע ב') + whenText(lastDone) + (past ? '' : ' · הבא: ' + whenText(ws.next));
    } else if (ws.state === 'due') {
      v.badge = ws.lastChance ? 'הזדמנות אחרונה' : 'אפשר היום';
      if (ws.lastChance) v.cls = 'due last';
      v.line = ws.lastChance ? 'היום היום האחרון בתקופה הזו' : 'עד ' + whenText(ws.last);
    } else if (ws.state === 'upcoming') {
      v.badge = 'בקרוב';
      v.line = 'הבא: ' + whenText(ws.next);
    } else {
      v.badge = 'לא בוצע';
      if (past) v.line = 'התקופה הזו עברה';
      else {
        var nw = L.nextWindow(h, ws.window);
        v.line = 'הבא: ' + whenText(L.firstAllowed(h, nw.start, nw.end) || nw.start);
      }
    }
    return v;
  }

  function overviewHTML_today() {
    return '<div class="ov-mini" id="ovMini">' +
      '<div class="om"><span>השבוע</span><b id="omWeek">—</b></div>' +
      '<div class="om" id="omMonthBox"><span>יעדי החודש</span><b id="omMonth">—</b></div>' +
      '<button type="button" class="om next" id="omNextBox" data-act="goto-next"><span>הבא בתור</span><b id="omNext">—</b></button>' +
    '</div>';
  }

  function weekStripHTML(d) {
    var ws = L.weekStart(d), dsToday = L.fmt(S.today);
    var cells = '';
    for (var i = 0; i < 7; i++) {
      var day = L.addDays(ws, i), ds = L.fmt(day);
      var future = day.getTime() > S.today.getTime();
      var st = L.dayStats(habitsFor(day), day, S.byDate, S.today);
      var show = !future && st.sched > 0;
      var full = show && st.done === st.sched;
      var cls = 'wk' + (ds === dsToday ? ' is-today' : '') + (ds === L.fmt(d) ? ' is-active' : '') + (future ? ' future' : '') + (full ? ' full' : '');
      cells += '<button type="button" class="' + cls + '" data-day="' + ds + '"' + (future ? ' tabindex="-1" aria-disabled="true"' : '') +
        ' aria-label="' + esc(dateText(day, { weekday: 'long', day: 'numeric', month: 'long' })) + (show ? ', ' + st.done + ' מתוך ' + st.sched : '') + '">' +
        '<span class="wkl">' + LETTER[i] + '</span>' +
        '<span class="ring sm" style="--p:' + (show ? Math.round(st.pct * 100) : 0) + '"><i>' + day.getDate() + '</i></span>' +
      '</button>';
    }
    return '<nav class="wk-strip" aria-label="ימי השבוע">' + cells + '</nav>';
  }

  function renderToday() {
    var d = S.viewDate, ds = L.fmt(d), todayStr = L.fmt(S.today);
    var isToday = ds === todayStr;
    var list = habitsFor(d);
    var main = list.filter(function (h) { return h.kind === 'main'; });
    var side = list.filter(function (h) { return h.kind === 'side'; });
    var goals = periodicHabits();
    var periods = ['week', '2weeks', 'month'].filter(function (p) { return goals.some(function (h) { return h.period === p; }); });
    var rel = isToday ? 'היום' : ds === L.fmt(L.addDays(S.today, -1)) ? 'אתמול' : '';
    var dt = dateText(d, { day: 'numeric', month: 'long' }) + (d.getFullYear() !== S.today.getFullYear() ? ' ' + d.getFullYear() : '');

    $('view-today').innerHTML =
      '<div class="today">' +
        '<header class="t-head">' +
          '<div class="t-date">' +
            '<h1>' + esc(dateText(d, { weekday: 'long' })) + (rel ? '<span class="rel' + (isToday ? '' : ' past') + '">' + rel + '</span>' : '') + '</h1>' +
            '<p>' + esc(dt) + '</p>' +
          '</div>' +
          '<div class="t-nav">' +
            (isToday ? '' : '<button type="button" class="pill" data-act="today">להיום</button>') +
            '<button type="button" class="ic" data-act="prev" aria-label="היום הקודם"><span class="flip">' + CHEV + '</span></button>' +
            '<button type="button" class="ic" data-act="next" aria-label="היום הבא"' + (isToday ? ' disabled' : '') + '>' + CHEV + '</button>' +
          '</div>' +
        '</header>' +
        '<aside class="t-aside">' +
          weekStripHTML(d) +
          '<section class="summary" id="summary" aria-live="polite">' +
            '<div class="prog-ring" id="progRing" style="--p:0"><div class="pr-in"><b id="pNum">0/0</b></div></div>' +
            '<div class="sm-txt"><b id="pText"></b><span id="pSub"></span></div>' +
          '</section>' +
          (goals.length ? overviewHTML_today() : '') +
          '<div id="remind"></div>' +
        '</aside>' +
        '<div class="t-main">' +
          '<section class="group" aria-labelledby="gMain">' +
            '<div class="g-head"><h2 id="gMain">' + (isToday ? 'מתוכנן להיום' : 'מתוכנן') + '</h2><span class="g-count" id="cMain"></span></div>' +
            (main.length
              ? '<div class="rows">' + main.map(function (h) { return rowHTML(h, d); }).join('') + '</div>'
              : '<p class="g-empty">אין משהו מתוכנן ' + (isToday ? 'היום' : 'ביום הזה') + '. רק משימות הצד.</p>') +
          '</section>' +
          (side.length ?
            '<section class="group side" aria-labelledby="gSide">' +
              '<div class="g-head"><h2 id="gSide">משימות צד</h2><span class="g-count" id="cSide"></span></div>' +
              '<div class="tiles">' + side.map(tileHTML).join('') + '</div>' +
            '</section>' : '') +
          periods.map(function (p) {
            var hs = goals.filter(function (h) { return h.period === p; });
            return '<section class="group goals" aria-labelledby="gP-' + p + '">' +
              '<div class="g-head"><h2 id="gP-' + p + '">' + GROUP_TITLE[p] + '</h2><span class="g-count" id="cP-' + p + '"></span></div>' +
              '<div class="goal-list">' + hs.map(function (h) { return goalHTML(h, d); }).join('') + '</div>' +
            '</section>';
          }).join('') +
        '</div>' +
      '</div>';
    paintToday(false);
    paintRemind();
  }

  // Updates checks + counters in place (no re-render), so a tap never moves anything on screen.
  function paintToday(animate) {
    var ds = L.fmt(S.viewDate);
    var done = S.byDate[ds] || {};
    var els = document.querySelectorAll('#view-today .row, #view-today .tile');
    var mainT = 0, mainD = 0, sideT = 0, sideD = 0;
    Array.prototype.forEach.call(els, function (btn) {
      var on = !!done[btn.getAttribute('data-id')];
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (btn.classList.contains('row')) { mainT++; if (on) mainD++; } else { sideT++; if (on) sideD++; }
    });
    var total = mainT + sideT, got = mainD + sideD;
    var complete = total > 0 && got === total;
    var mainComplete = mainT > 0 && mainD === mainT;
    var text, sub;
    var left = total - got;
    if (!total) { text = 'יום חופשי'; sub = 'אין הרגלים ביום הזה'; }
    else if (complete) { text = 'הכל בוצע'; sub = S.viewDate.getTime() === S.today.getTime() ? 'יום מושלם. כל הכבוד!' : 'יום מושלם'; }
    else {
      text = left === 1 ? 'נשארה משימה אחת' : 'נשארו ' + left + ' משימות';
      sub = mainT ? (mainComplete ? 'המתוכנן הושלם, נשארו משימות צד' : 'מתוכנן ' + mainD + '/' + mainT + (sideT ? ' · צד ' + sideD + '/' + sideT : ''))
                  : 'צד ' + sideD + '/' + sideT;
    }
    var ring = $('progRing'), sm = $('summary');
    if (ring) ring.style.setProperty('--p', total ? Math.round(got / total * 100) : 0);
    if (sm) {
      var was = sm.classList.contains('full');
      sm.classList.toggle('full', complete);
      if (animate && complete && !was && !reduceMotion()) { sm.classList.remove('cheer'); void sm.offsetWidth; sm.classList.add('cheer'); }
    }
    if ($('pNum')) $('pNum').textContent = total ? got + '/' + total : '—';
    if ($('pText')) $('pText').textContent = text;
    if ($('pSub')) $('pSub').textContent = sub;
    if ($('cMain')) { $('cMain').textContent = mainD + '/' + mainT; $('cMain').classList.toggle('ok', mainComplete); }
    if ($('cSide')) { $('cSide').textContent = sideD + '/' + sideT; $('cSide').classList.toggle('ok', sideT > 0 && sideD === sideT); }
    paintGoals();
    // keep today's ring in the week strip in sync too
    var wk = document.querySelector('#view-today .wk[data-day="' + ds + '"] .ring');
    if (wk) {
      wk.style.setProperty('--p', total ? Math.round(got / total * 100) : 0);
      wk.parentNode.classList.toggle('full', complete);
    }
  }

  function paintGoals() {
    var goals = periodicHabits(), per = {}, nextBest = null;
    goals.forEach(function (h) {
      var btn = document.querySelector('#view-today .goal[data-goal="' + h.id + '"]');
      var v = goalView(h), ws = v.ws;
      (per[h.period] = per[h.period] || { met: 0, n: 0 }).n++;
      if (ws.state === 'done') per[h.period].met++;
      // "next up" is always about the real today (even while browsing an earlier day):
      // the soonest thing still to do; when everything is met, the soonest next period.
      var now = L.sameDay(S.viewDate, S.today) ? ws : L.windowState(h, S.today, S.byDate, S.today);
      var when = now.state === 'due' ? S.today : now.next;
      if (now.state === 'missed') { var nw = L.nextWindow(h, now.window); when = L.firstAllowed(h, nw.start, nw.end); }
      if (when) {
        var rank = (now.state === 'done' ? 1e6 : 0) + L.dayNum(when);
        if (!nextBest || rank < nextBest.rank) nextBest = { rank: rank, h: h, when: when, done: now.state === 'done' };
      }
      if (!btn) return;
      btn.className = 'goal is-' + v.cls.split(' ').join(' is-') + (ws.state === 'done' ? ' on' : '');
      btn.setAttribute('aria-pressed', ws.state === 'done' ? 'true' : 'false');
      btn.setAttribute('aria-label', h.title + ', ' + freqText(h) + ', ' + ws.count + ' מתוך ' + ws.target + ' ' + PERIOD_WORD[h.period] + ', ' + v.badge);
      var segs = '';
      for (var i = 0; i < ws.target; i++) segs += '<i' + (i < ws.count ? ' class="f"' : '') + '></i>';
      btn.querySelector('.segs').innerHTML = segs;
      btn.querySelector('.gp-t').textContent = Math.min(ws.count, ws.target) + '/' + ws.target + ' ' + PERIOD_WORD[h.period];
      btn.querySelector('.gl').textContent = v.line;
      btn.querySelector('.gs').textContent = v.badge;
    });
    Object.keys(per).forEach(function (p) {
      var c = $('cP-' + p);
      if (c) { c.textContent = per[p].met + '/' + per[p].n; c.classList.toggle('ok', per[p].met === per[p].n); }
    });

    // overview strip
    if (!$('ovMini')) return;
    var wk = L.weekProgress(S.habits, S.viewDate, S.byDate);
    $('omWeek').textContent = wk.total ? wk.done + '/' + wk.total : '—';
    var monthly = goals.filter(function (h) { return h.period === 'month'; });
    $('omMonthBox').hidden = !monthly.length;
    if (monthly.length) {
      var met = monthly.filter(function (h) { return L.windowState(h, S.viewDate, S.byDate, S.today).state === 'done'; }).length;
      $('omMonth').textContent = met + '/' + monthly.length;
      $('omMonthBox').classList.toggle('ok', met === monthly.length);
    }
    var nb = $('omNextBox');
    if (nextBest) {
      nb.hidden = false;
      nb.dataset.goal = nextBest.h.id;
      $('omNext').textContent = nextBest.h.title + ' · ' + whenText(nextBest.when);
      nb.classList.toggle('now', !nextBest.done && L.sameDay(nextBest.when, S.today));
    } else nb.hidden = true;
  }

  // One tap on a goal card: mark the viewed day; tap again (same day) to undo.
  // If the period's target was reached on another day, offer to undo that one instead.
  function toggleGoal(btn) {
    var id = btn.getAttribute('data-goal'), h = habitById(id), ds = L.fmt(S.viewDate);
    var ws = L.windowState(h, S.viewDate, S.byDate, S.today);
    if (S.byDate[ds] && S.byDate[ds][id]) {
      setDone(ds, id, false);
      paintToday(true);
      toast('הסימון בוטל · ' + h.title, 'החזרה', function () { setDone(ds, id, true); paintToday(true); });
      return;
    }
    if (ws.count >= ws.target) {
      var last = ws.dates[ws.dates.length - 1], lds = L.fmt(last);
      toast(h.title + ' כבר בוצע ' + whenText(last), 'ביטול הסימון', function () {
        setDone(lds, id, false); paintToday(true);
      });
      return;
    }
    setDone(ds, id, true);
    paintToday(true);
    btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
    if (navigator.vibrate) navigator.vibrate(8);
    toast('סומן: ' + h.title, 'ביטול', function () { setDone(ds, id, false); paintToday(true); });
  }

  /* ---- undo toast (only for goal cards, whose state covers a whole period) ---- */
  var toastTimer = null, toastUndo = null;
  function toast(text, action, undo) {
    var t = $('toast');
    if (!t) return;
    toastUndo = undo || null;
    t.innerHTML = '<span>' + esc(text) + '</span>' + (undo ? '<button type="button" data-undo>' + esc(action) + '</button>' : '');
    t.hidden = false;
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 4500);
  }
  function hideToast() {
    var t = $('toast');
    if (!t) return;
    t.classList.remove('show');
    toastUndo = null;
    setTimeout(function () { if (!t.classList.contains('show')) t.hidden = true; }, 220);
  }
  $('toast').addEventListener('click', function (e) {
    if (!e.target.closest('[data-undo]')) return;
    var fn = toastUndo;
    hideToast();
    if (fn) fn();
  });

  function toggleRow(btn) {
    var id = btn.getAttribute('data-id'), ds = L.fmt(S.viewDate);
    var on = !(S.byDate[ds] && S.byDate[ds][id]);
    setDone(ds, id, on);
    paintToday(true);
    if (on) {
      btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
      if (navigator.vibrate) navigator.vibrate(8);
    }
  }

  function setViewDate(d) {
    S.viewDate = d;
    renderToday();
    ensureData(todayFrom(d)).then(function () {
      if (S.tab === 'today' && L.fmt(S.viewDate) === L.fmt(d)) { renderToday(); }
    });
  }

  $('view-today').addEventListener('click', function (e) {
    var row = e.target.closest('.row, .tile');
    if (row) { toggleRow(row); return; }
    var goal = e.target.closest('.goal');
    if (goal) { toggleGoal(goal); return; }
    var wk = e.target.closest('.wk-strip .wk');
    if (wk && !wk.classList.contains('future')) { setViewDate(L.parse(wk.getAttribute('data-day'))); return; }
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var a = b.getAttribute('data-act');
    if (a === 'remind-on') { b.disabled = true; enableRemind(); return; }
    if (a === 'remind-x') { save(REMIND_HIDE, true); paintRemind(); return; }
    if (a === 'goto-next') {
      var card = document.querySelector('#view-today .goal[data-goal="' + b.dataset.goal + '"]');
      if (card) {
        card.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
        card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
      }
      return;
    }
    if (a === 'prev') setViewDate(L.addDays(S.viewDate, -1));
    else if (a === 'next' && S.viewDate.getTime() < S.today.getTime()) setViewDate(L.addDays(S.viewDate, 1));
    else if (a === 'today') setViewDate(S.today);
  });
  $('view-today').addEventListener('animationend', function (e) {
    var row = e.target.closest && e.target.closest('.row, .tile, .goal');
    if (row) row.classList.remove('pop', 'flash');
  });

  /* ------------------------------------------------------------------ HISTORY */
  var SCOPES = [['main', 'מתוכננות'], ['side', 'משימות צד'], ['all', 'הכל']];
  var RANGES = [['7', '7 ימים'], ['30', '30 יום'], ['90', '3 חודשים'], ['all', 'הכל']];
  var PERIODS = [['week', 'שבוע'], ['month', 'חודש'], ['year', 'שנה']];
  // Rolling window behind the headline % and the per-habit list, per selected period.
  var ROLLING = { week: { days: 7, text: '7 ימים' }, month: { days: 30, text: '30 ימים' }, year: { days: 365, text: 'שנה' } };

  function seg(items, active, attr) {
    return '<div class="seg" role="group">' + items.map(function (it) {
      return '<button type="button" ' + attr + '="' + it[0] + '" aria-pressed="' + (it[0] === active ? 'true' : 'false') + '">' + esc(it[1]) + '</button>';
    }).join('') + '</div>';
  }

  function renderHistory() {
    $('view-history').innerHTML =
      '<div class="h-top"><header class="h-head"><h1>היסטוריה</h1></header>' +
      '<div class="seg big" role="tablist">' +
        '<button type="button" role="tab" data-htab="overview" aria-selected="' + (S.hTab === 'overview') + '">סקירה</button>' +
        '<button type="button" role="tab" data-htab="habit" aria-selected="' + (S.hTab === 'habit') + '">לפי הרגל</button>' +
      '</div></div><div id="hBody"></div>';
    paintHistory();
    loadHistoryData();
  }

  var histToken = 0;
  async function loadHistoryData() {
    var token = ++histToken;
    await ensureFirst();
    var start = startDate();
    var from;
    if (S.hTab === 'habit') from = rangeFrom(start);
    else from = L.addDays(L.weekStart(S.today), -7 * 25);
    if (S.weekStart < from) from = S.weekStart;
    if (L.monthStart(S.monthRef) < from) from = L.monthStart(S.monthRef);
    if (S.hTab === 'overview' && S.period === 'year') {
      if (S.yearRef < from) from = S.yearRef;
      if (L.addDays(S.today, -364) < from) from = L.addDays(S.today, -364);
    }
    await ensureData(L.fmt(from));
    if (S.hTab === 'overview') {
      var hs = scopeHabits();
      var t = await fetchTotal(hs.map(function (h) { return h.id; }));
      if (t !== null) S.totals[S.scope] = t;
    }
    if (token === histToken && S.tab === 'history') paintHistory();
  }

  function paintHistory() {
    var box = $('hBody');
    if (!box) return;
    var start = startDate();
    box.innerHTML = S.hTab === 'overview' ? overviewHTML(start) : habitPageHTML(start);
    if (S.hTab === 'overview') {
      var sc = box.querySelector('.hm-scroll');
      if (sc) sc.scrollLeft = sc.scrollWidth;
    }
    Array.prototype.forEach.call(document.querySelectorAll('#view-history [data-htab]'), function (b) {
      var on = b.getAttribute('data-htab') === S.hTab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  /* ---- overview ---- */
  function overviewHTML(start) {
    var hs = scopeHabits();
    var today = S.today;
    var roll = ROLLING[S.period];
    var rr = L.rangeStats(hs, L.addDays(today, -(roll.days - 1)), today, S.byDate, today, start);
    var streak = L.perfectDayStreak(hs, start || today, today, S.byDate, today, start);
    var total = S.totals[S.scope] !== undefined ? S.totals[S.scope] : L.totalDone(hs, S.byDate);

    var html = '<div class="ov-ctl"><div class="period" aria-label="טווח זמן">' + seg(PERIODS, S.period, 'data-period') + '</div>' +
      '<div class="scope">' + seg(SCOPES, S.scope, 'data-scope') + '</div></div>';

    html += '<div class="stats">' +
      '<div><b>' + pctText(rr.pct) + '</b><small>ביצוע ' + (S.period === 'year' ? 'בשנה האחרונה' : 'ב-' + roll.text) + '</small></div>' +
      '<div><b>' + streak.current + '</b><small>ימים מושלמים ברצף</small></div>' +
      '<div><b>' + num(total) + '</b><small>סה״כ בוצעו</small></div>' +
    '</div>';

    var cards = S.period === 'week' ? weekHTML(hs, start) + weekFactsHTML(hs, start)
      : S.period === 'year' ? yearHTML(hs, start) + yearBarsHTML(hs, start)
      : weekHTML(hs, start) + monthHTML(hs, start);
    html += '<div class="ov-grid">' + cards + heatmapHTML(hs, start) + lowestHTML(hs, start) + '</div>';
    return html;
  }

  function weekLabel(ws) {
    var we = L.addDays(ws, 6);
    var m = function (d) { return dateText(d, { month: 'short' }); };
    return ws.getMonth() === we.getMonth()
      ? ws.getDate() + '–' + we.getDate() + ' ' + m(we)
      : ws.getDate() + ' ' + m(ws) + ' – ' + we.getDate() + ' ' + m(we);
  }

  function weekHTML(hs, start) {
    var isCurrent = S.weekStart.getTime() >= L.weekStart(S.today).getTime();
    var cols = '';
    for (var i = 0; i < 7; i++) {
      var d = L.addDays(S.weekStart, i), ds = L.fmt(d);
      var future = d.getTime() > S.today.getTime();
      var before = start && d.getTime() < start.getTime();
      var st = L.dayStats(hs, d, S.byDate, S.today);
      var show = !future && !before && st.sched > 0;
      cols += '<button type="button" class="wd' + (ds === L.fmt(S.today) ? ' is-today' : '') + '" data-day="' + ds + '"' + (future ? ' disabled' : '') + '>' +
        '<span class="wl">' + LETTER[i] + '</span>' +
        '<span class="ring" style="--p:' + (show ? Math.round(st.pct * 100) : 0) + '"><i>' + d.getDate() + '</i></span>' +
        '<span class="wc">' + (show ? st.done + '/' + st.sched : '—') + '</span></button>';
    }
    return '<section class="h-sec s-week"><div class="sec-t"><h2>השבוע</h2><div class="nav2">' +
      '<button type="button" class="ic sm" data-act="wk-prev" aria-label="שבוע קודם"><span class="flip">' + CHEV + '</span></button>' +
      '<span>' + weekLabel(S.weekStart) + '</span>' +
      '<button type="button" class="ic sm" data-act="wk-next" aria-label="שבוע הבא"' + (isCurrent ? ' disabled' : '') + '>' + CHEV + '</button>' +
      '</div></div><div class="week">' + cols + '</div></section>';
  }

  function heatmapHTML(hs, start) {
    var weeks = 26, today = S.today;
    var first = L.addDays(L.weekStart(today), -7 * (weeks - 1));
    var months = '', cells = '', prevMonth = -1;
    for (var w = 0; w < weeks; w++) {
      var ws = L.addDays(first, w * 7);
      if (ws.getMonth() !== prevMonth) {
        months += '<span style="grid-column:' + (w + 1) + ' / span 3">' + esc(dateText(ws, { month: 'short' })) + '</span>';
        prevMonth = ws.getMonth();
      }
      for (var r = 0; r < 7; r++) {
        var d = L.addDays(ws, r), ds = L.fmt(d);
        if (d.getTime() > today.getTime()) { cells += '<span class="hc gone"></span>'; continue; }
        var lv = (start && d.getTime() < start.getTime()) ? -1 : L.level(L.dayStats(hs, d, S.byDate, today).pct);
        var st = L.dayStats(hs, d, S.byDate, today);
        cells += '<button type="button" class="hc' + (ds === L.fmt(today) ? ' is-today' : '') + '" data-day="' + ds + '" data-l="' + lv + '" aria-label="' +
          esc(dateText(d, { day: 'numeric', month: 'long' })) + ', ' + st.done + ' מתוך ' + st.sched + '"></button>';
      }
    }
    var days = LETTER.map(function (l) { return '<span>' + l + '</span>'; }).join('');
    return '<section class="h-sec s-heat"><div class="sec-t"><h2>ההתמדה שלי</h2></div><p class="q">איך נראו הימים האחרונים? לחץ על יום לפירוט.</p>' +
      '<div class="hm"><div class="hm-days">' + days + '</div><div class="hm-scroll"><div class="hm-months">' + months + '</div><div class="hm-grid">' + cells + '</div></div></div>' +
      '<div class="legend"><span>פחות</span><i data-l="0"></i><i data-l="1"></i><i data-l="2"></i><i data-l="3"></i><i data-l="4"></i><span>יותר</span></div></section>';
  }

  // Neutral facts for one calendar period (week / month / year).
  function factsHTML(mo, emptyText) {
    if (mo.avg === null) return '<p class="empty">' + emptyText + '</p>';
    return '<dl class="facts">' +
        '<div><dt>ממוצע ביצוע</dt><dd>' + pctText(mo.avg) + '</dd></div>' +
        '<div><dt>היום המוביל</dt><dd>' + (mo.days ? esc(dateText(mo.days.date, { day: 'numeric', month: 'long' })) + ' (' + mo.days.done + '/' + mo.days.sched + ')' : '—') + '</dd></div>' +
        '<div><dt>ההרגל העקבי ביותר</dt><dd>' + (mo.top ? esc(mo.top.habit.title) + ' (' + pctText(mo.top.pct) + ')' : '—') + '</dd></div>' +
      '</dl>';
  }

  // Period title + optional prev/next navigation (nav: [prevAct, nextAct, prevLabel, nextLabel, isCurrent]).
  function periodHead(title, label, nav) {
    if (!nav) return '<div class="sec-t"><h2>' + title + '</h2><div class="nav2"><span>' + esc(label) + '</span></div></div>';
    return '<div class="sec-t"><h2>' + title + '</h2><div class="nav2">' +
      '<button type="button" class="ic sm" data-act="' + nav[0] + '" aria-label="' + nav[2] + '"><span class="flip">' + CHEV + '</span></button>' +
      '<span>' + esc(label) + '</span>' +
      '<button type="button" class="ic sm" data-act="' + nav[1] + '" aria-label="' + nav[3] + '"' + (nav[4] ? ' disabled' : '') + '>' + CHEV + '</button>' +
      '</div></div>';
  }

  function monthHTML(hs, start) {
    var mo = L.monthOverview(hs, S.monthRef, S.byDate, S.today, start);
    var isCurrent = S.monthRef.getTime() >= L.monthStart(S.today).getTime();
    return '<section class="h-sec s-month">' +
      periodHead('חודשי', dateText(S.monthRef, { month: 'long', year: 'numeric' }), ['mo-prev', 'mo-next', 'חודש קודם', 'חודש הבא', isCurrent]) +
      factsHTML(mo, 'אין עדיין נתונים בחודש הזה.') + '</section>';
  }

  // Week view: facts for the same week the "השבוע" card is showing (its arrows drive both).
  function weekFactsHTML(hs, start) {
    var mo = L.periodOverview(hs, S.weekStart, L.addDays(S.weekStart, 6), S.byDate, S.today, start);
    return '<section class="h-sec s-month">' + periodHead('שבועי', weekLabel(S.weekStart), null) +
      factsHTML(mo, 'אין עדיין נתונים בשבוע הזה.') + '</section>';
  }

  function yearHTML(hs, start) {
    var mo = L.periodOverview(hs, S.yearRef, L.yearEnd(S.yearRef), S.byDate, S.today, start);
    var isCurrent = S.yearRef.getFullYear() >= S.today.getFullYear();
    return '<section class="h-sec s-month">' +
      periodHead('שנתי', String(S.yearRef.getFullYear()), ['yr-prev', 'yr-next', 'שנה קודמת', 'שנה הבאה', isCurrent]) +
      factsHTML(mo, 'אין עדיין נתונים בשנה הזו.') + '</section>';
  }

  // Year view: one bar per month. Tapping a month opens it in the month view.
  function yearBarsHTML(hs, start) {
    var y = S.yearRef.getFullYear();
    var ser = L.groupSeries(hs, S.yearRef, L.yearEnd(S.yearRef), 'month', S.byDate, S.today, start);
    var any = false, bars = '', labels = '';
    for (var m = 0; m < 12; m++) {
      var ms = new Date(y, m, 1);
      var future = ms.getTime() > S.today.getTime();
      var pct = ser[m] ? ser[m].pct : null;
      if (pct !== null) any = true;
      var height = pct === null ? 0 : Math.max(pct * 100, 4);
      var lbl = dateText(ms, { month: 'long' }) + ', ' + pctText(pct);
      bars += '<button type="button" class="b' + (pct === null ? ' na' : pct === 0 ? ' z' : '') + '" style="--h:' + height.toFixed(0) + '%" data-month="' + L.fmt(ms) + '"' +
        (future ? ' disabled' : '') + ' title="' + esc(lbl) + '" aria-label="' + esc(lbl) + '"><i></i></button>';
      labels += '<span>' + esc(dateText(ms, { month: 'short' })) + '</span>';
    }
    var body = any
      ? '<p class="q">איך זה השתנה לאורך השנה? לחץ על חודש לפירוט.</p>' +
        '<div class="bars u-month" style="--c:var(--ok)">' + bars + '</div><div class="bl twelve">' + labels + '</div>'
      : '<p class="empty">אין עדיין נתונים בשנה הזו.</p>';
    return '<section class="h-sec s-year">' + periodHead('חודש אחר חודש', String(y), null) + body + '</section>';
  }

  function lowestHTML(hs, start) {
    var roll = ROLLING[S.period];
    var rates = L.habitRates(hs, L.addDays(S.today, -(roll.days - 1)), S.today, S.byDate, S.today, start);
    var body = rates.length ? rates.map(function (r) {
      return '<button type="button" class="hb" data-habit="' + esc(r.habit.id) + '" style="--c:var(--' + L.colorOf(r.habit) + ')">' +
        '<span class="hn">' + esc(r.habit.title) + '</span><span class="tr"><i style="width:' + Math.round(r.pct * 100) + '%"></i></span>' +
        '<span class="hp">' + pctText(r.pct) + '</span></button>';
    }).join('') : '<p class="empty">אין עדיין נתונים.</p>';
    return '<section class="h-sec s-rates"><div class="sec-t"><h2>לפי הרגל</h2></div><p class="q">אילו הרגלים אני משלים פחות? (' + roll.text + ', מהנמוך לגבוה)</p>' + body + '</section>';
  }

  /* ---- per-habit page ---- */
  function rangeFrom(start) {
    var t = S.today;
    if (S.hRange === '7') return L.addDays(t, -6);
    if (S.hRange === '30') return L.addDays(t, -29);
    if (S.hRange === '90') return L.addDays(t, -89);
    return start || t;
  }

  function habitPageHTML(start) {
    var h = habitById(S.hHabit);
    var from = rangeFrom(start);
    var today = S.today;
    var eff = start && from.getTime() < start.getTime() ? start : from;
    var r = L.rangeStats([h], from, today, S.byDate, today, start);
    var st = L.habitStreak(h, from, today, S.byDate, today, start);

    var chips = S.habits.slice().sort(bySort).map(function (x) {
      return '<button type="button" class="hchip' + (x.id === h.id ? ' on' : '') + '" data-habit="' + esc(x.id) + '" style="--c:var(--' + L.colorOf(x) + ')">' + esc(x.title) + '</button>';
    }).join('');

    var html = '<div class="chips">' + chips + '</div>' +
      '<p class="h-freq">' + esc(freqText(h)) + (L.isPeriodic(h) || h.weekdays.length < 7 ? ' · ' + esc(daysText(h)) : '') + '</p>' +
      '<div class="scope">' + seg(RANGES, S.hRange, 'data-range') + '</div>';
    if (!r.den) {
      return html + '<p class="empty big">אין עדיין נתונים בטווח הזה.</p>';
    }
    html += '<div class="stats">' +
      '<div><b>' + pctText(r.pct) + '</b><small>' + r.num + ' מתוך ' + r.den + '</small></div>' +
      '<div><b>' + st.current + '</b><small>רצף נוכחי</small></div>' +
      '<div><b>' + st.best + '</b><small>רצף שיא</small></div></div>';

    var spanDays = Math.round((today.getTime() - eff.getTime()) / 86400000) + 1;
    var unit = (S.hRange === '7' || S.hRange === '30') ? 'day' : (spanDays / 7 <= 26 ? 'week' : 'month');
    if (h.period === 'month') unit = 'month';
    else if (L.isPeriodic(h) && unit === 'day') unit = 'week';
    var ser = L.series(h, from, today, unit, S.byDate, today, start).filter(function (b) {
      return !start || b.end.getTime() >= start.getTime();
    });
    var bars = ser.map(function (b) {
      var height = b.pct === null ? 0 : Math.max(b.pct * 100, 4);
      var lbl = unit === 'day' ? dateText(b.start, { day: 'numeric', month: 'long' }) : weekLabel(b.start);
      return '<div class="b' + (b.pct === null ? ' na' : b.pct === 0 ? ' z' : '') + '" style="--h:' + height.toFixed(0) + '%" role="img" aria-label="' + esc(lbl) + ', ' + pctText(b.pct) + '"><i></i></div>';
    }).join('');
    var labels = '';
    if (S.hRange === '7' && unit === 'day') {
      labels = '<div class="bl seven">' + ser.map(function (b) { return '<span>' + LETTER[b.start.getDay()] + '</span>'; }).join('') + '</div>';
    } else if (ser.length) {
      var f = ser[0].start, l = ser[ser.length - 1].end;
      labels = '<div class="bl ends"><span>' + esc(dateText(f, { day: 'numeric', month: 'short' })) + '</span><span>' + esc(dateText(l, { day: 'numeric', month: 'short' })) + '</span></div>';
    }
    var q = unit === 'day' ? 'באילו ימים עשיתי את זה?' : unit === 'week' ? 'איך זה השתנה משבוע לשבוע?' : 'איך זה השתנה מחודש לחודש?';
    html += '<section class="h-sec s-bars"><p class="q">' + q + '</p><div class="bars u-' + unit + '" style="--c:var(--' + L.colorOf(h) + ')">' + bars + '</div>' + labels + '</section>';
    return html;
  }

  /* ---- history events ---- */
  function repaintAndLoad() { paintHistory(); loadHistoryData(); }

  $('view-history').addEventListener('click', function (e) {
    var t;
    if ((t = e.target.closest('[data-htab]'))) { S.hTab = t.getAttribute('data-htab'); repaintAndLoad(); return; }
    if ((t = e.target.closest('[data-period]'))) { S.period = t.getAttribute('data-period'); save(KEY.period, S.period); repaintAndLoad(); return; }
    if ((t = e.target.closest('[data-month]'))) {
      if (t.disabled) return;
      S.monthRef = L.parse(t.getAttribute('data-month')); S.period = 'month'; save(KEY.period, S.period);
      repaintAndLoad(); return;
    }
    if ((t = e.target.closest('[data-scope]'))) { S.scope = t.getAttribute('data-scope'); repaintAndLoad(); return; }
    if ((t = e.target.closest('[data-range]'))) { S.hRange = t.getAttribute('data-range'); repaintAndLoad(); return; }
    if ((t = e.target.closest('[data-habit]'))) { S.hHabit = t.getAttribute('data-habit'); S.hTab = 'habit'; renderHistory(); window.scrollTo(0, 0); return; }
    if ((t = e.target.closest('[data-day]'))) { if (!t.disabled) openDay(t.getAttribute('data-day')); return; }
    if ((t = e.target.closest('[data-act]'))) {
      if (t.disabled) return;
      var a = t.getAttribute('data-act');
      if (a === 'wk-prev') S.weekStart = L.addDays(S.weekStart, -7);
      else if (a === 'wk-next') S.weekStart = L.addDays(S.weekStart, 7);
      else if (a === 'mo-prev') S.monthRef = new Date(S.monthRef.getFullYear(), S.monthRef.getMonth() - 1, 1);
      else if (a === 'mo-next') S.monthRef = new Date(S.monthRef.getFullYear(), S.monthRef.getMonth() + 1, 1);
      else if (a === 'yr-prev') S.yearRef = new Date(S.yearRef.getFullYear() - 1, 0, 1);
      else if (a === 'yr-next') S.yearRef = new Date(S.yearRef.getFullYear() + 1, 0, 1);
      repaintAndLoad();
    }
  });

  /* ---- day sheet ---- */
  var sheetOpen = false;
  function openDay(ds) {
    var d = L.parse(ds);
    var list = S.habits.filter(function (h) { return L.status(h, d, S.byDate, S.today) !== 'na'; }).sort(bySort);
    var st = L.dayStats(list, d, S.byDate, S.today);
    var future = d.getTime() > S.today.getTime();
    var isToday = ds === L.fmt(S.today);
    var rows = list.map(function (h) {
      var s = L.status(h, d, S.byDate, S.today);
      var label = s === 'done' ? 'בוצע' : s === 'miss' ? 'לא בוצע' : s === 'pending' ? 'עוד לא סומן' : '';
      return '<li class="sr ' + s + '" style="--c:var(--' + L.colorOf(h) + ')"><span class="dot">' + (s === 'done' ? '✓' : '') + '</span>' +
        '<span class="sn">' + esc(h.title) + (L.isPeriodic(h) ? '<small>' + esc(freqText(h)) + '</small>' : '') + '</span><span class="ss">' + label + '</span></li>';
    }).join('');
    $('sheetBody').innerHTML =
      '<h2 id="sheetTitle">' + esc(dateText(d, { weekday: 'long', day: 'numeric', month: 'long' })) + '</h2>' +
      '<p class="sub">' + (list.length ? st.done + ' מתוך ' + st.sched + ' הושלמו' : 'אין הרגלים ביום הזה') + '</p>' +
      '<ul class="sl">' + rows + '</ul>' +
      (future ? '' : '<button type="button" class="btn" data-edit="' + ds + '">' + (isToday ? 'לסימון היום' : 'עריכת היום') + '</button>');
    var w = $('sheet');
    w.hidden = false;
    void w.offsetWidth;
    w.classList.add('open');
    sheetOpen = true;
  }
  function closeSheet() {
    if (!sheetOpen) return;
    var w = $('sheet');
    w.classList.remove('open');
    sheetOpen = false;
    setTimeout(function () { if (!sheetOpen) w.hidden = true; }, 260);
  }
  $('sheet').addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) { closeSheet(); return; }
    var ed = e.target.closest('[data-edit]');
    if (ed) { var d = L.parse(ed.getAttribute('data-edit')); closeSheet(); go('today'); setViewDate(d); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  /* ------------------------------------------------------------------ lifecycle */
  function refreshDay() {
    var nt = L.midnight(new Date());
    if (nt.getTime() === S.today.getTime()) return;
    var wasToday = S.viewDate.getTime() === S.today.getTime();
    S.today = nt;
    if (wasToday) S.viewDate = nt;
    S.weekStart = L.weekStart(nt);
    S.monthRef = L.monthStart(nt);
    S.yearRef = L.yearStart(nt);
    S.loadedFrom = null;
    go(S.tab);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    refreshDay();
    S.loadedFrom = null;
    if (S.tab === 'today') {
      ensureData(todayFrom(S.viewDate)).then(function () { if (S.tab === 'today') renderToday(); });
    }
    flush();
  });
  window.addEventListener('online', function () { backoff = 4000; flush(); if (!S.sb) initSupabase(); });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('service-worker.js').catch(function () {});
    });
  }

  // Start: paint from local data immediately, connect in the background.
  renderToday();
  initSupabase();
})();
