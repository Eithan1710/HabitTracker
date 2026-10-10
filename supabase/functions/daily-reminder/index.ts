// daily-reminder: sends the 21:00 (Asia/Jerusalem) "mark today's habits" push.
// Called by pg_cron at 18:00 and 19:00 UTC; only the call that lands on 21:00 local
// time sends (covers summer and winter time). Skips if everything is already marked.
// Auth: header x-cron-secret must match push_config.cron_secret. ?force=1 skips the hour check (testing).
//
// What counts as "left today" (same rules as habits.js):
//  - period 'day' habits whose weekdays include today and that aren't marked today;
//  - periodic habits (week / 2weeks / month) only on the LAST allowed day of their period,
//    and only if the period's target hasn't been reached — a "last chance" nudge, never a daily nag.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const TZ = "Asia/Jerusalem";
const SITE = "https://eithan1710.github.io/HabitTracker/";
const DEFAULT_ANCHOR = "2026-10-04";

type Habit = { id: string; title?: string; weekdays: number[]; period?: string; target?: number; anchor?: string | null };

function localNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday: wd };
}

// Calendar-day helpers on plain "YYYY-MM-DD" strings (UTC-based, so no DST surprises).
const dayNum = (s: string) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
const fromNum = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);
const weekdayOf = (n: number) => new Date(n * 86400000).getUTCDay();

function windowOf(h: Habit, today: string): [number, number] {
  const t = dayNum(today);
  if (h.period === "week") { const s = t - weekdayOf(t); return [s, s + 6]; }
  if (h.period === "month") {
    const y = +today.slice(0, 4), m = +today.slice(5, 7) - 1;
    return [Math.round(Date.UTC(y, m, 1) / 86400000), Math.round(Date.UTC(y, m + 1, 0) / 86400000)];
  }
  if (h.period === "2weeks") {
    const a0 = dayNum(h.anchor || DEFAULT_ANCHOR), a = a0 - weekdayOf(a0);
    const s = a + Math.floor((t - a) / 14) * 14;
    return [s, s + 13];
  }
  return [t, t];
}
function lastAllowed(h: Habit, w: [number, number]) {
  for (let d = w[1]; d >= w[0]; d--) if (h.weekdays.includes(weekdayOf(d))) return d;
  return w[1];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data: cfgRows, error: cfgErr } = await sb.from("push_config").select("key,value");
  if (cfgErr) return json({ error: "config" }, 500);
  const cfg = Object.fromEntries((cfgRows ?? []).map((r) => [r.key, r.value]));
  if (!cfg.cron_secret || req.headers.get("x-cron-secret") !== cfg.cron_secret) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const now = localNow();
  if (now.hour !== 21 && url.searchParams.get("force") !== "1") return json({ skipped: "not 21:00 local", now });

  // Schedule columns may not exist on an older database: fall back to plain weekday habits.
  let habits: Habit[] = [];
  const full = await sb.from("habits").select("id,title,weekdays,period,target,anchor");
  if (!full.error) habits = (full.data ?? []) as Habit[];
  else habits = ((await sb.from("habits").select("id,title,weekdays")).data ?? []) as Habit[];

  const t = dayNum(now.date);
  const daily = habits.filter((h) => !h.period || h.period === "day");
  const periodic = habits.filter((h) => h.period && h.period !== "day");
  const wins = new Map(periodic.map((h) => [h.id, windowOf(h, now.date)]));
  const from = Math.min(t, ...[...wins.values()].map((w) => w[0]));

  const { data: done } = await sb.from("completions").select("habit_id,date")
    .eq("completed", true).gte("date", fromNum(from)).lte("date", now.date);
  const doneToday = new Set((done ?? []).filter((d) => d.date === now.date).map((d) => d.habit_id));

  const todays = daily.filter((h) => h.weekdays.includes(now.weekday));
  const lastChance = periodic.filter((h) => {
    const w = wins.get(h.id)!;
    if (lastAllowed(h, w) !== t) return false;
    const count = (done ?? []).filter((d) => d.habit_id === h.id && dayNum(d.date) >= w[0] && dayNum(d.date) <= w[1]).length;
    return count < Math.max(1, h.target ?? 1);
  });

  const due = todays.length + lastChance.length;
  const left = todays.filter((h) => !doneToday.has(h.id)).length + lastChance.length;
  if (due && left === 0) return json({ skipped: "all done", now });

  let body = left === due
    ? "עוד לא סימנת אף הרגל היום. לוקח 3 שניות 💪"
    : left === 1 ? "נשאר הרגל אחד לסמן היום" : `נשארו ${left} הרגלים לסמן היום`;
  if (lastChance.length) body += ` · היום היום האחרון ל${lastChance.map((h) => h.title || h.id).join(" ול")}`;

  webpush.setVapidDetails(cfg.vapid_subject || "mailto:noreply@example.com", cfg.vapid_public, cfg.vapid_private);
  const { data: subs } = await sb.from("push_subscriptions").select("endpoint,p256dh,auth");
  const payload = JSON.stringify({ title: "הרגלים", body, url: SITE });

  let sent = 0;
  const gone: string[] = [];
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3 * 3600, urgency: "high" });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) gone.push(s.endpoint);
      else console.error("push failed", code, String(e));
    }
  }));
  if (gone.length) await sb.from("push_subscriptions").delete().in("endpoint", gone);

  return json({ sent, removed: gone.length, left, lastChance: lastChance.map((h) => h.id), now });
});
