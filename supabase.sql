-- =====================================================================
-- Habit tracker: Supabase schema (single user, no login)
-- Run once: Supabase Dashboard -> SQL Editor -> New query -> paste -> Run
-- Safe to run again (idempotent). Nothing here deletes data.
--
-- If you already ran an earlier version of this script (the one with
-- user_id / login) and have no real data yet, run this first:
--   drop table if exists public.completions;
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) habits: the existing habits, exactly as they are today.
--    Reference data. The app can read it but never changes it.
--    weekdays: 0 = Sunday ... 6 = Saturday.  time_labels: weekday -> text.
-- ---------------------------------------------------------------------
create table if not exists public.habits (
  id          text primary key,
  title       text not null,
  kind        text not null check (kind in ('main', 'side')),   -- main = planned, side = daily side mission
  hint        text,
  weekdays    smallint[] not null,
  time_labels jsonb not null default '{}'::jsonb,
  sort_order  smallint not null,
  constraint habits_weekdays_valid check (
    cardinality(weekdays) between 1 and 7
    and weekdays <@ array[0,1,2,3,4,5,6]::smallint[]
  )
);

insert into public.habits (id, title, kind, hint, weekdays, time_labels, sort_order) values
  ('gym',       'חדר כושר',              'main', 'לרשום את האימון ב-Hevy',       '{0,1,3,4}',     '{"0":"18:00–19:30","1":"18:00–19:30","3":"18:00–19:30","4":"18:00–19:30"}', 1),
  ('salsa',     'שיעור סלסה',            'main', null,                            '{2}',           '{"2":"21:30–00:00"}', 2),
  ('run',       'ריצה',                  'main', 'ריצה קלה',                      '{5,6}',         '{"5":"ערב, לפני היציאה","6":"ערב"}', 3),
  ('friends',   'יציאה עם חברים',        'main', null,                            '{5}',           '{"5":"ערב"}', 4),
  ('reminders', 'בדיקת תזכורות בטלפון',  'main', 'לוודא שלא שכחתי משהו חשוב',    '{6}',           '{"6":"אחרי הריצה"}', 5),
  ('protein',   '120 גרם חלבון',         'side', null,                            '{0,1,2,3,4,5,6}', '{}', 6),
  ('clean',     'בלי שטויות',            'side', null,                            '{0,1,2,3,4,5,6}', '{}', 7),
  ('steps',     '7,000 צעדים',           'side', null,                            '{0,1,2,3,4,5,6}', '{}', 8),
  ('sleep',     'שינה 7+ שעות',          'side', 'הלילה שעבר',                    '{0,1,2,3,4,5,6}', '{}', 9)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2) completions: one row per habit + day.
--    The primary key is the duplicate guard: the same habit can never
--    appear twice on the same date.
-- ---------------------------------------------------------------------
create table if not exists public.completions (
  habit_id     text        not null references public.habits (id) on update cascade on delete restrict,
  date         date        not null,                     -- local calendar day
  completed    boolean     not null default true,
  completed_at timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (habit_id, date),
  constraint completions_date_sane check (date between date '2020-01-01' and date '2100-01-01')
);

-- History screens read by date range.
create index if not exists completions_date_idx on public.completions (date desc);

-- ---------------------------------------------------------------------
-- 3) Trigger: keeps updated_at / completed_at correct on every write.
-- ---------------------------------------------------------------------
create or replace function public.completions_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  if new.completed then
    if tg_op = 'UPDATE' and old.completed then
      new.completed_at := coalesce(new.completed_at, old.completed_at, now());
    else
      new.completed_at := coalesce(new.completed_at, now());
    end if;
  else
    new.completed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists completions_touch on public.completions;
create trigger completions_touch
  before insert or update on public.completions
  for each row execute function public.completions_touch();

-- ---------------------------------------------------------------------
-- 4) Row Level Security, no login.
--    The site uses the public "anon" key, so the anon role may read habits,
--    and read / add / update completions. It can NOT delete anything
--    (unticking is stored as completed = false) and can not touch the
--    habits table.
--    Trade-off: anyone who has your site address can also read and edit
--    these rows. Keep the address to yourself.
-- ---------------------------------------------------------------------
alter table public.habits      enable row level security;
alter table public.completions enable row level security;

revoke all on public.habits      from anon, authenticated;
revoke all on public.completions from anon, authenticated;
grant select                 on public.habits      to anon;
grant select, insert, update on public.completions to anon;

drop policy if exists habits_read on public.habits;
create policy habits_read on public.habits
  for select to anon using (true);

drop policy if exists completions_read on public.completions;
create policy completions_read on public.completions
  for select to anon using (true);

drop policy if exists completions_insert on public.completions;
create policy completions_insert on public.completions
  for insert to anon with check (true);

drop policy if exists completions_update on public.completions;
create policy completions_update on public.completions
  for update to anon using (true) with check (true);

-- Drop the old per-user policies if an earlier version was run.
drop policy if exists completions_select_own on public.completions;
drop policy if exists completions_insert_own on public.completions;
drop policy if exists completions_update_own on public.completions;
drop policy if exists completions_delete_own on public.completions;

-- ---------------------------------------------------------------------
-- Optional sanity checks:
--   select id, title, kind, weekdays from public.habits order by sort_order;
--   select habit_id, count(*) from public.completions group by 1 order by 2 desc;
-- ---------------------------------------------------------------------
