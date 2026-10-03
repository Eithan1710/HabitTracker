// daily-reminder: sends the 21:00 (Asia/Jerusalem) "mark today's habits" push.
// Called by pg_cron at 18:00 and 19:00 UTC; only the call that lands on 21:00 local
// time sends (covers summer and winter time). Skips if everything is already marked.
// Auth: header x-cron-secret must match push_config.cron_secret. ?force=1 skips the hour check (testing).
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const TZ = "Asia/Jerusalem";
const SITE = "https://eithan1710.github.io/HabitTracker/";

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

  const [{ data: habits }, { data: done }] = await Promise.all([
    sb.from("habits").select("id,weekdays"),
    sb.from("completions").select("habit_id").eq("date", now.date).eq("completed", true),
  ]);
  const todays = (habits ?? []).filter((h) => (h.weekdays as number[]).includes(now.weekday));
  const doneIds = new Set((done ?? []).map((d) => d.habit_id));
  const left = todays.filter((h) => !doneIds.has(h.id)).length;
  if (todays.length && left === 0) return json({ skipped: "all done", now });

  const body = left === todays.length
    ? "עוד לא סימנת אף הרגל היום. לוקח 3 שניות 💪"
    : left === 1 ? "נשאר הרגל אחד לסמן היום" : `נשארו ${left} הרגלים לסמן היום`;

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

  return json({ sent, removed: gone.length, left, now });
});
