/* app.js — Habit tracker UI + Supabase sync.
 * Local-first: every tap updates the screen and localStorage immediately, then a
 * background queue upserts to Supabase (and retries when the connection returns).
 */
(function () {
  'use strict';

  var L = window.HabitLogic;
  var CFG = window.HABITS_CONFIG || {};
  var SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
  var KEY = { habits: 'hb:v1:habits', done: 'hb:v1:done', pending: 'hb:v1:pending', user: 'hb:v1:user', first: 'hb:v1:first' };
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
    user: load(KEY.user, null),
    first: load(KEY.first, null),
    firstChecked: false,
    sb: null,
    needLogin: false,
    today: L.midnight(new Date()),
    viewDate: L.midnight(new Date()),
    tab: 'today',
    hTab: 'overview',
    scope: 'main',
    hHabit: 'gym',
    hRange: '30',
    weekStart: L.weekStart(L.midnight(new Date())),
    monthRef: L.monthStart(new Date()),
    loadedFrom: null,
    loadedAt: 0,
    totals: {},
    lastSync: null
  };
  S.hHabit = (S.habits[0] || {}).id || 'gym';

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
    paintSync();
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
  function canSync() { return !!(S.sb && S.user && !S.needLogin); }
  function isAuthError(e) {
    return !!e && (e.status === 401 || e.code === 'PGRST301' || e.code === '42501' || /jwt|not authenticated/i.test(e.message || ''));
  }

  var flushing = false, flushTimer = null, retryTimer = null, backoff = 4000;
  function scheduleFlush(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms); }

  async function flush() {
    if (flushing || !canSync()) { paintSync(); return; }
    var keys = Object.keys(S.pending);
    if (!keys.length) { paintSync(); return; }
    flushing = true;
    paintSync();
    var batch = keys.slice(0, 300).map(function (k) { return S.pending[k]; });
    var rows = batch.map(function (op) {
      return { user_id: S.user.id, habit_id: op.habit_id, date: op.date, completed: op.completed };
    });
    try {
      var r = await S.sb.from('completions').upsert(rows, { onConflict: 'user_id,habit_id,date' });
      if (r.error) throw r.error;
      batch.forEach(function (op) {
        var k = op.date + '|' + op.habit_id;
        if (S.pending[k] && S.pending[k].ts === op.ts) delete S.pending[k];
      });
      persistPending();
      S.lastSync = Date.now();
      backoff = 4000;
      flushing = false;
      if (Object.keys(S.pending).length) { flush(); return; }
    } catch (e) {
      flushing = false;
      if (isAuthError(e)) { await recoverAuth(); }
      else {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(flush, backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    }
    paintSync();
  }

  async function recoverAuth() {
    try {
      var r = await S.sb.auth.refreshSession();
      if (r.error || !r.data || !r.data.session) throw new Error('no session');
      scheduleFlush(50);
    } catch (e) {
      if (navigator.onLine === false) { clearTimeout(retryTimer); retryTimer = setTimeout(flush, backoff); }
      else { S.needLogin = true; showLogin(); }
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

  async function syncDay(ds) {
    if (!canSync()) return;
    try {
      var rows = await fetchRange(ds, ds);
      applyServer(ds, ds, rows);
      if (S.tab === 'today' && L.fmt(S.viewDate) === ds) paintToday();
    } catch (e) { /* offline: keep local */ }
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
      var r = await S.sb.from('habits').select('id,title,kind,hint,weekdays,time_labels,sort_order').order('sort_order');
      if (r.error || !r.data || !r.data.length) return;
      S.habits = r.data.map(L.normalizeHabit).sort(bySort);
      save(KEY.habits, r.data);
      if (S.tab === 'today') renderToday();
    } catch (e) {}
  }

  function bootSync() {
    refreshHabits();
    syncDay(L.fmt(S.viewDate));
    ensureFirst();
    flush();
  }

  /* ------------------------------------------------------------------ auth */
  function setUser(u) {
    S.user = { id: u.id, email: u.email || '' };
    save(KEY.user, S.user);
    S.needLogin = false;
  }

  function isNetworkError(e) {
    return !!e && (e.name === 'AuthRetryableFetchError' || /fetch|network|timeout/i.test(e.message || ''));
  }

  var initing = false;
  async function initSupabase() {
    if (!CONFIGURED) { paintSync(); return; }
    if (initing || S.sb) return;
    initing = true;
    try {
      if (!S.user) showLogin();
      try { await loadScript(SDK_URL, 9000); } catch (e) { paintSync(); return; }
      if (!window.supabase || !window.supabase.createClient) return;
      S.sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
      S.sb.auth.onAuthStateChange(function (evt, session) {
        if (evt === 'SIGNED_OUT') {
          setTimeout(function () { S.needLogin = true; showLogin(); }, 0);
        } else if (session && session.user && (evt === 'SIGNED_IN' || evt === 'TOKEN_REFRESHED')) {
          setTimeout(function () { setUser(session.user); scheduleFlush(50); }, 0);
        }
      });
      $('lgBtn').disabled = false;
      var session = null, err = null;
      try {
        var res = await S.sb.auth.getSession();
        session = res && res.data && res.data.session;
        err = res && res.error;
      } catch (e) { err = e; }
      if (session && session.user) { setUser(session.user); hideLogin(); bootSync(); }
      else if (S.user && (navigator.onLine === false || isNetworkError(err))) { hideLogin(); }   // remembered user, no connection
      else { S.needLogin = true; showLogin(); }
    } finally {
      initing = false;
    }
  }

  function showLogin() { $('login').hidden = false; $('lgBtn').disabled = !S.sb; setTimeout(function () { $('lgEmail').focus(); }, 60); }
  function hideLogin() { $('login').hidden = true; }

  $('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('lgErr');
    err.textContent = '';
    if (!S.sb) { err.textContent = 'אין חיבור כרגע. נסה שוב כשיש רשת.'; return; }
    $('lgBtn').disabled = true;
    try {
      var r = await S.sb.auth.signInWithPassword({ email: $('lgEmail').value.trim(), password: $('lgPass').value });
      if (r.error || !r.data || !r.data.user) throw (r.error || new Error('fail'));
      setUser(r.data.user);
      $('lgPass').value = '';
      hideLogin();
      bootSync();
      if (S.tab === 'settings') renderSettings();
    } catch (ex) {
      err.textContent = 'האימייל או הסיסמה לא נכונים, או שאין חיבור.';
    }
    $('lgBtn').disabled = false;
  });

  /* ------------------------------------------------------------------ sync indicator */
  function syncDetailText() {
    var n = Object.keys(S.pending).length;
    var parts = [];
    if (!CONFIGURED) return 'Supabase לא הוגדר. הנתונים נשמרים במכשיר הזה בלבד. כדי לחבר, ממלאים את config.js.';
    if (!S.user) parts.push('לא מחובר.');
    else if (!S.sb) parts.push('מצב לא מקוון. הסימונים נשמרים במכשיר ויישלחו כשיהיה חיבור.');
    else parts.push('מחובר ומסונכרן.');
    parts.push(n ? 'ממתינים לשליחה: ' + n + '.' : 'הכל נשלח.');
    if (S.lastSync) parts.push('סנכרון אחרון: ' + new Date(S.lastSync).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) + '.');
    return parts.join(' ');
  }
  function paintSync() {
    var n = Object.keys(S.pending).length;
    var b = $('syncBadge');
    if (b) {
      if (CONFIGURED && n > 0) { b.hidden = false; b.textContent = flushing ? 'שולח…' : 'ממתין לסנכרון (' + n + ')'; }
      else b.hidden = true;
    }
    var d = $('syncDetail');
    if (d) d.textContent = syncDetailText();
  }

  /* ------------------------------------------------------------------ navigation */
  function go(tab) {
    S.tab = tab;
    ['today', 'history', 'settings'].forEach(function (t) {
      $('view-' + t).hidden = t !== tab;
      $('nav-' + t).setAttribute('aria-current', t === tab ? 'page' : 'false');
    });
    if (tab === 'today') renderToday();
    if (tab === 'history') renderHistory();
    if (tab === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }
  ['today', 'history', 'settings'].forEach(function (t) {
    $('nav-' + t).addEventListener('click', function () { go(t); });
  });

  /* ------------------------------------------------------------------ TODAY */
  var CHECK = '<span class="chk" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg></span>';
  var CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';

  function rowHTML(h, d, kind) {
    var tl = h.time_labels && h.time_labels[d.getDay()];
    var meta = '';
    if (kind === 'main') {
      if (tl) meta += '<span class="chip">' + esc(tl) + '</span>';
      if (h.hint) meta += '<span>' + esc(h.hint) + '</span>';
    } else if (h.hint) meta = '<span>' + esc(h.hint) + '</span>';
    return '<button type="button" class="row ' + kind + '" data-id="' + esc(h.id) + '" aria-pressed="false" style="--c:var(--' + L.colorOf(h) + ')">' +
      CHECK + '<span class="rt"><b>' + esc(h.title) + '</b>' + (meta ? '<span class="rm">' + meta + '</span>' : '') + '</span></button>';
  }

  function renderToday() {
    var d = S.viewDate, ds = L.fmt(d), todayStr = L.fmt(S.today);
    var isToday = ds === todayStr;
    var list = habitsFor(d);
    var main = list.filter(function (h) { return h.kind === 'main'; });
    var side = list.filter(function (h) { return h.kind === 'side'; });
    var rel = isToday ? 'היום' : ds === L.fmt(L.addDays(S.today, -1)) ? 'אתמול' : '';
    var dt = dateText(d, { day: 'numeric', month: 'long' }) + (d.getFullYear() !== S.today.getFullYear() ? ' ' + d.getFullYear() : '');

    $('view-today').innerHTML =
      '<header class="t-head">' +
        '<div class="t-top">' +
          '<button type="button" class="ic" data-act="prev" aria-label="היום הקודם"><span class="flip">' + CHEV + '</span></button>' +
          '<div class="t-date"><h1>' + esc(dateText(d, { weekday: 'long' })) + (rel ? '<span class="rel">' + rel + '</span>' : '') + '</h1><p>' + esc(dt) + '</p></div>' +
          '<button type="button" class="ic" data-act="next" aria-label="היום הבא"' + (isToday ? ' disabled' : '') + '>' + CHEV + '</button>' +
        '</div>' +
        (isToday ? '' : '<button type="button" class="pill" data-act="today">חזרה להיום</button>') +
        '<div class="prog"><span id="pText"></span><div class="prog-bar"><i id="pFill"></i></div></div>' +
        '<span class="badge" id="syncBadge" hidden></span>' +
      '</header>' +
      '<section class="rows" aria-label="מתוכנן">' + main.map(function (h) { return rowHTML(h, d, 'main'); }).join('') + '</section>' +
      (side.length ?
        '<section class="sides" aria-label="משימות צד"><div class="side-h"><span>משימות צד</span><span id="sideCount"></span></div>' +
        '<div class="side-list">' + side.map(function (h) { return rowHTML(h, d, 'side'); }).join('') + '</div></section>' : '');
    paintToday();
    paintSync();
  }

  function paintToday() {
    var ds = L.fmt(S.viewDate);
    var done = S.byDate[ds] || {};
    var rows = document.querySelectorAll('#view-today .row');
    var mainT = 0, mainD = 0, sideT = 0, sideD = 0;
    Array.prototype.forEach.call(rows, function (btn) {
      var on = !!done[btn.getAttribute('data-id')];
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (btn.classList.contains('main')) { mainT++; if (on) mainD++; } else { sideT++; if (on) sideD++; }
    });
    var total = mainT || sideT, got = mainT ? mainD : sideD;
    var complete = (mainT ? mainD === mainT : true) && (sideT ? sideD === sideT : true);
    var mainComplete = mainT > 0 && mainD === mainT;
    var text;
    if (complete) text = 'הכל בוצע ✓';
    else if (mainComplete) text = 'המשימות המתוכננות הושלמו ✓';
    else { var left = total - got; text = left === 1 ? 'נשארה משימה אחת' : 'נשארו ' + left + ' משימות'; }
    var fill = $('pFill'), pt = $('pText');
    if (fill) {
      fill.style.width = (total ? Math.round(got / total * 100) : 0) + '%';
      fill.parentNode.parentNode.classList.toggle('full', mainComplete || complete);
    }
    if (pt) pt.textContent = text + (complete ? '' : '  ' + got + '/' + total);
    var sc = $('sideCount');
    if (sc) sc.textContent = sideD + '/' + sideT;
  }

  function toggleRow(btn) {
    var id = btn.getAttribute('data-id'), ds = L.fmt(S.viewDate);
    var on = !(S.byDate[ds] && S.byDate[ds][id]);
    setDone(ds, id, on);
    paintToday();
    if (on) {
      btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
      if (navigator.vibrate) navigator.vibrate(8);
    }
  }

  function setViewDate(d) {
    S.viewDate = d;
    renderToday();
    syncDay(L.fmt(d));
  }

  $('view-today').addEventListener('click', function (e) {
    var row = e.target.closest('.row');
    if (row) { toggleRow(row); return; }
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var a = b.getAttribute('data-act');
    if (a === 'prev') setViewDate(L.addDays(S.viewDate, -1));
    else if (a === 'next' && S.viewDate.getTime() < S.today.getTime()) setViewDate(L.addDays(S.viewDate, 1));
    else if (a === 'today') setViewDate(S.today);
  });
  $('view-today').addEventListener('animationend', function (e) {
    var row = e.target.closest && e.target.closest('.row');
    if (row) row.classList.remove('pop');
  });

  /* ------------------------------------------------------------------ HISTORY */
  var SCOPES = [['main', 'מתוכננות'], ['side', 'משימות צד'], ['all', 'הכל']];
  var RANGES = [['7', '7 ימים'], ['30', '30 יום'], ['90', '3 חודשים'], ['all', 'הכל']];

  function seg(items, active, attr) {
    return '<div class="seg" role="group">' + items.map(function (it) {
      return '<button type="button" ' + attr + '="' + it[0] + '" aria-pressed="' + (it[0] === active ? 'true' : 'false') + '">' + esc(it[1]) + '</button>';
    }).join('') + '</div>';
  }

  function renderHistory() {
    $('view-history').innerHTML =
      '<header class="h-head"><h1>היסטוריה</h1></header>' +
      '<div class="seg big" role="tablist">' +
        '<button type="button" role="tab" data-htab="overview" aria-selected="' + (S.hTab === 'overview') + '">סקירה</button>' +
        '<button type="button" role="tab" data-htab="habit" aria-selected="' + (S.hTab === 'habit') + '">לפי הרגל</button>' +
      '</div><div id="hBody"></div>';
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
    var r30 = L.rangeStats(hs, L.addDays(today, -29), today, S.byDate, today, start);
    var streak = L.perfectDayStreak(hs, start || today, today, S.byDate, today, start);
    var total = S.totals[S.scope] !== undefined ? S.totals[S.scope] : L.totalDone(hs, S.byDate);

    var html = '<div class="scope">' + seg(SCOPES, S.scope, 'data-scope') + '</div>';

    html += '<div class="stats">' +
      '<div><b>' + pctText(r30.pct) + '</b><small>ביצוע ב-30 ימים</small></div>' +
      '<div><b>' + streak.current + '</b><small>ימים מושלמים ברצף</small></div>' +
      '<div><b>' + num(total) + '</b><small>סה״כ בוצעו</small></div>' +
    '</div>';

    html += weekHTML(hs, start) + heatmapHTML(hs, start) + monthHTML(hs, start) + lowestHTML(hs, start);
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
    return '<section class="h-sec"><div class="sec-t"><h2>השבוע</h2><div class="nav2">' +
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
    return '<section class="h-sec"><div class="sec-t"><h2>ההתמדה שלי</h2></div><p class="q">איך נראו הימים האחרונים? לחץ על יום לפירוט.</p>' +
      '<div class="hm"><div class="hm-days">' + days + '</div><div class="hm-scroll"><div class="hm-months">' + months + '</div><div class="hm-grid">' + cells + '</div></div></div>' +
      '<div class="legend"><span>פחות</span><i data-l="0"></i><i data-l="1"></i><i data-l="2"></i><i data-l="3"></i><i data-l="4"></i><span>יותר</span></div></section>';
  }

  function monthHTML(hs, start) {
    var mo = L.monthOverview(hs, S.monthRef, S.byDate, S.today, start);
    var isCurrent = S.monthRef.getTime() >= L.monthStart(S.today).getTime();
    var rows;
    if (mo.avg === null) rows = '<p class="empty">אין עדיין נתונים בחודש הזה.</p>';
    else rows =
      '<dl class="facts">' +
        '<div><dt>ממוצע ביצוע</dt><dd>' + pctText(mo.avg) + '</dd></div>' +
        '<div><dt>היום המוביל</dt><dd>' + (mo.days ? esc(dateText(mo.days.date, { day: 'numeric', month: 'long' })) + ' (' + mo.days.done + '/' + mo.days.sched + ')' : '—') + '</dd></div>' +
        '<div><dt>ההרגל העקבי ביותר</dt><dd>' + (mo.top ? esc(mo.top.habit.title) + ' (' + pctText(mo.top.pct) + ')' : '—') + '</dd></div>' +
      '</dl>';
    return '<section class="h-sec"><div class="sec-t"><h2>חודשי</h2><div class="nav2">' +
      '<button type="button" class="ic sm" data-act="mo-prev" aria-label="חודש קודם"><span class="flip">' + CHEV + '</span></button>' +
      '<span>' + esc(dateText(S.monthRef, { month: 'long', year: 'numeric' })) + '</span>' +
      '<button type="button" class="ic sm" data-act="mo-next" aria-label="חודש הבא"' + (isCurrent ? ' disabled' : '') + '>' + CHEV + '</button>' +
      '</div></div>' + rows + '</section>';
  }

  function lowestHTML(hs, start) {
    var rates = L.habitRates(hs, L.addDays(S.today, -29), S.today, S.byDate, S.today, start);
    var body = rates.length ? rates.map(function (r) {
      return '<button type="button" class="hb" data-habit="' + esc(r.habit.id) + '" style="--c:var(--' + L.colorOf(r.habit) + ')">' +
        '<span class="hn">' + esc(r.habit.title) + '</span><span class="tr"><i style="width:' + Math.round(r.pct * 100) + '%"></i></span>' +
        '<span class="hp">' + pctText(r.pct) + '</span></button>';
    }).join('') : '<p class="empty">אין עדיין נתונים.</p>';
    return '<section class="h-sec"><div class="sec-t"><h2>לפי הרגל</h2></div><p class="q">אילו הרגלים אני משלים פחות? (30 ימים, מהנמוך לגבוה)</p>' + body + '</section>';
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

    var html = '<div class="chips">' + chips + '</div>' + '<div class="scope">' + seg(RANGES, S.hRange, 'data-range') + '</div>';
    if (!r.den) {
      return html + '<p class="empty big">אין עדיין נתונים בטווח הזה.</p>';
    }
    html += '<div class="stats">' +
      '<div><b>' + pctText(r.pct) + '</b><small>' + r.num + ' מתוך ' + r.den + '</small></div>' +
      '<div><b>' + st.current + '</b><small>רצף נוכחי</small></div>' +
      '<div><b>' + st.best + '</b><small>רצף שיא</small></div></div>';

    var spanDays = Math.round((today.getTime() - eff.getTime()) / 86400000) + 1;
    var unit = (S.hRange === '7' || S.hRange === '30') ? 'day' : (spanDays / 7 <= 26 ? 'week' : 'month');
    var ser = L.series(h, from, today, unit, S.byDate, today, start).filter(function (b) {
      return !start || b.end.getTime() >= start.getTime();
    });
    var bars = ser.map(function (b) {
      var height = b.pct === null ? 0 : Math.max(b.pct * 100, 4);
      var lbl = unit === 'day' ? dateText(b.start, { day: 'numeric', month: 'long' }) : weekLabel(b.start);
      return '<div class="b' + (b.pct === null ? ' na' : b.pct === 0 ? ' z' : '') + '" style="--h:' + height.toFixed(0) + '%" role="img" aria-label="' + esc(lbl) + ', ' + pctText(b.pct) + '"><i></i></div>';
    }).join('');
    var labels = '';
    if (S.hRange === '7') {
      labels = '<div class="bl seven">' + ser.map(function (b) { return '<span>' + LETTER[b.start.getDay()] + '</span>'; }).join('') + '</div>';
    } else if (ser.length) {
      var f = ser[0].start, l = ser[ser.length - 1].end;
      labels = '<div class="bl ends"><span>' + esc(dateText(f, { day: 'numeric', month: 'short' })) + '</span><span>' + esc(dateText(l, { day: 'numeric', month: 'short' })) + '</span></div>';
    }
    var q = unit === 'day' ? 'באילו ימים עשיתי את זה?' : unit === 'week' ? 'איך זה השתנה משבוע לשבוע?' : 'איך זה השתנה מחודש לחודש?';
    html += '<section class="h-sec"><p class="q">' + q + '</p><div class="bars u-' + unit + '" style="--c:var(--' + L.colorOf(h) + ')">' + bars + '</div>' + labels + '</section>';
    return html;
  }

  /* ---- history events ---- */
  function repaintAndLoad() { paintHistory(); loadHistoryData(); }

  $('view-history').addEventListener('click', function (e) {
    var t;
    if ((t = e.target.closest('[data-htab]'))) { S.hTab = t.getAttribute('data-htab'); repaintAndLoad(); return; }
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
      repaintAndLoad();
    }
  });

  /* ---- day sheet ---- */
  var sheetOpen = false;
  function openDay(ds) {
    var d = L.parse(ds);
    var list = habitsFor(d);
    var st = L.dayStats(list, d, S.byDate, S.today);
    var future = d.getTime() > S.today.getTime();
    var isToday = ds === L.fmt(S.today);
    var rows = list.map(function (h) {
      var s = L.status(h, d, S.byDate, S.today);
      var label = s === 'done' ? 'בוצע' : s === 'miss' ? 'לא בוצע' : s === 'pending' ? 'עוד לא סומן' : '';
      return '<li class="sr ' + s + '" style="--c:var(--' + L.colorOf(h) + ')"><span class="dot">' + (s === 'done' ? '✓' : '') + '</span><span class="sn">' + esc(h.title) + '</span><span class="ss">' + label + '</span></li>';
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

  /* ------------------------------------------------------------------ SETTINGS */
  function renderSettings() {
    $('view-settings').innerHTML =
      '<header class="h-head"><h1>הגדרות</h1></header>' +
      '<section class="set"><h2>חשבון</h2><p>' + (S.user && S.user.email ? esc(S.user.email) : (S.user ? 'מחובר' : 'לא מחובר')) + '</p>' +
        (CONFIGURED ? (S.user ? '<button type="button" class="btn ghost" id="signOut">התנתקות</button>' : '<button type="button" class="btn" id="signIn">התחברות</button>') : '') + '</section>' +
      '<section class="set"><h2>סנכרון</h2><p id="syncDetail"></p>' +
        (CONFIGURED ? '<button type="button" class="btn ghost" id="syncNow">סנכרון עכשיו</button>' : '') + '</section>' +
      '<section class="set"><h2>ייבוא מהאתר הישן</h2>' +
        '<p>באתר הישן: פתח "ייצוא נתונים", העתק את הטקסט והדבק כאן. אפשר לייבא שוב בבטחה, אין כפילויות.</p>' +
        '<textarea id="impText" rows="4" dir="ltr" spellcheck="false" placeholder="{ &quot;format&quot;: &quot;habits-export-v1&quot; ... }"></textarea>' +
        '<button type="button" class="btn ghost" id="impBtn">ייבוא</button><p class="msg" id="impMsg" role="status"></p></section>' +
      '<p class="ver">גרסה 1.0</p>';
    paintSync();
  }

  var signOutArmed = false, signOutTimer = null;
  $('view-settings').addEventListener('click', async function (e) {
    var t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'signIn') { showLogin(); return; }
    if (t.id === 'syncNow') { bootSync(); return; }
    if (t.id === 'impBtn') { doImport(); return; }
    if (t.id === 'signOut') {
      var n = Object.keys(S.pending).length;
      if (n && !signOutArmed) {
        signOutArmed = true;
        t.textContent = 'יש ' + n + ' סימונים שלא נשלחו. לחץ שוב כדי להתנתק';
        signOutTimer = setTimeout(function () { signOutArmed = false; t.textContent = 'התנתקות'; }, 4000);
        return;
      }
      clearTimeout(signOutTimer); signOutArmed = false;
      try { await S.sb.auth.signOut(); } catch (ex) {}
      S.byDate = {}; S.pending = {}; S.user = null; S.first = null; S.loadedFrom = null; S.totals = {};
      persistDone(); persistPending(); save(KEY.user, null); save(KEY.first, null);
      showLogin();
      renderSettings();
    }
  });

  function doImport() {
    var msg = $('impMsg'), txt = $('impText').value.trim();
    msg.textContent = '';
    if (!txt) { msg.textContent = 'הדבק קודם את טקסט הייצוא.'; return; }
    var data;
    try { data = JSON.parse(txt); } catch (e) { msg.textContent = 'הטקסט לא תקין. ודא שהעתקת את כולו.'; return; }
    var rows = Array.isArray(data) ? data : (data && data.completions);
    if (!Array.isArray(rows)) { msg.textContent = 'לא נמצאו סימונים בקובץ.'; return; }
    var ids = {};
    S.habits.forEach(function (h) { ids[h.id] = 1; });
    var limit = L.fmt(L.addDays(S.today, 1));
    var seen = {}, count = 0, skipped = 0;
    rows.forEach(function (r) {
      var ds = r && r.date, id = r && (r.habit || r.habit_id);
      if (typeof ds !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ds) || ds > limit || !ids[id]) { skipped++; return; }
      var k = ds + '|' + id;
      if (seen[k]) return;
      seen[k] = 1;
      markLocal(ds, id, true);
      enqueue(ds, id, true);
      count++;
    });
    persistDone(); persistPending();
    S.loadedFrom = null;
    msg.textContent = 'יובאו ' + count + ' סימונים' + (skipped ? ' (' + skipped + ' דולגו)' : '') + '. הם יישלחו לענן ברקע.';
    $('impText').value = '';
    scheduleFlush(100);
    paintSync();
  }

  /* ------------------------------------------------------------------ lifecycle */
  function refreshDay() {
    var nt = L.midnight(new Date());
    if (nt.getTime() === S.today.getTime()) return;
    var wasToday = S.viewDate.getTime() === S.today.getTime();
    S.today = nt;
    if (wasToday) S.viewDate = nt;
    S.weekStart = L.weekStart(nt);
    S.monthRef = L.monthStart(nt);
    S.loadedFrom = null;
    go(S.tab);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    refreshDay();
    if (S.tab === 'today') syncDay(L.fmt(S.viewDate));
    flush();
  });
  window.addEventListener('online', function () { backoff = 4000; flush(); if (!S.sb) initSupabase(); });
  window.addEventListener('offline', paintSync);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('service-worker.js').catch(function () {});
    });
  }

  // Start: paint from local data immediately, connect in the background.
  renderToday();
  initSupabase();
})();
