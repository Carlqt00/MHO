-- ============================================================
-- 0008_provider_time_off_and_slot_gen.sql
-- Admin: provider availability → time-slot generation.
--
-- Adds:
--   1. provider_time_off  — exception dates (personal leave when
--      provider_id is set; clinic-wide holiday when provider_id is NULL)
--      on which NO slots are generated.
--   2. generate_time_slots(...) — parameterised, idempotent slot
--      generator that supersedes the hardcoded 0004_test_slots.sql.
--
-- SECURITY NOTE: generate_time_slots is SECURITY DEFINER, which RUNS AS
-- THE OWNER AND BYPASSES RLS. The "admin: manage time slots" policy does
-- NOT protect it. Authorization is therefore enforced INSIDE the function
-- via an explicit is_admin() check, and EXECUTE is granted to
-- authenticated only (never anon).
-- ============================================================

-- ------------------------------------------------------------
-- provider_time_off — no-slot exception dates
-- ------------------------------------------------------------
create table public.provider_time_off (
  id             uuid primary key default gen_random_uuid(),
  provider_id    uuid references public.providers (id) on delete cascade, -- NULL = clinic-wide holiday
  exception_date date not null,
  reason         text,
  created_at     timestamptz not null default now(),
  -- one personal entry per provider per date (NULLs are distinct, so this
  -- does not constrain clinic-wide rows — the partial index below does)
  unique (provider_id, exception_date)
);

-- at most one clinic-wide holiday per date
create unique index uniq_clinic_holiday_per_date
  on public.provider_time_off (exception_date)
  where provider_id is null;

-- fast "is this date an exception for this provider (or clinic-wide)?" lookup
create index idx_provider_time_off_date
  on public.provider_time_off (exception_date, provider_id);

alter table public.provider_time_off enable row level security;

create policy "authenticated: select time off"
  on public.provider_time_off for select to authenticated
  using (true);

create policy "admin: manage time off"
  on public.provider_time_off for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ------------------------------------------------------------
-- generate_time_slots(p_provider_id, p_service_id, p_from, p_to,
--                      p_interval_minutes, p_dry_run)
--
-- Expands the provider's weekly availability across [p_from, p_to] into
-- concrete time_slots at p_interval_minutes spacing, for ONE service.
--
-- Idempotent:  insert ... on conflict (provider_id, slot_datetime) do
--              nothing — re-running never duplicates.
-- Collision-safe: because it is INSERT-ONLY with conflict-ignore, an
--              existing slot (booked or not) is never touched, so a booked
--              appointment can never be clobbered or double-generated.
-- Exceptions:  a date that is a personal leave (provider_id) OR a
--              clinic-wide holiday (provider_id is null) is skipped whole.
-- Preview:     p_dry_run = true counts everything but writes nothing. The
--              same code path is used for preview and commit, so they agree.
--
-- Returns a jsonb summary (to_create, already_exist, exception_days,
-- days_with_availability, and a small sample of timestamps).
-- ------------------------------------------------------------
create or replace function public.generate_time_slots(
  p_provider_id      uuid,
  p_service_id       uuid,
  p_from             date,
  p_to               date,
  p_interval_minutes int  default 30,
  p_dry_run          boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date        date;
  v_dow         int;
  v_win         record;
  v_slot_time   time;
  v_step        interval := make_interval(mins => p_interval_minutes);
  v_slot_ts     timestamptz;
  v_to_create   int := 0;
  v_existing    int := 0;
  v_exc_days    int := 0;
  v_avail_days  int := 0;
  v_had_window  boolean;
  v_sample      jsonb := '[]'::jsonb;
begin
  -- ---- AUTHORIZATION (SECURITY DEFINER bypasses RLS — guard here!) ----
  if not public.is_admin() then
    raise exception 'ERR_FORBIDDEN: only an administrator can generate slots';
  end if;

  -- ---- validation ----
  if p_interval_minutes is null or p_interval_minutes < 5 or p_interval_minutes > 480 then
    raise exception 'ERR_INVALID_INTERVAL: interval must be between 5 and 480 minutes';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'ERR_INVALID_RANGE: from-date must be on or before to-date';
  end if;
  if (p_to - p_from) > 180 then
    raise exception 'ERR_RANGE_TOO_LARGE: date range cannot exceed 180 days';
  end if;
  if not exists (select 1 from providers where id = p_provider_id) then
    raise exception 'ERR_NOT_FOUND: provider does not exist';
  end if;
  if not exists (select 1 from services where id = p_service_id) then
    raise exception 'ERR_NOT_FOUND: service does not exist';
  end if;

  -- ---- expand each date in the range ----
  for v_date in
    select gs::date from generate_series(p_from, p_to, '1 day'::interval) gs
  loop
    v_dow := extract(dow from v_date);

    -- skip exception days entirely (personal leave OR clinic-wide holiday)
    if exists (
      select 1 from provider_time_off t
      where t.exception_date = v_date
        and (t.provider_id = p_provider_id or t.provider_id is null)
    ) then
      v_exc_days := v_exc_days + 1;
      continue;
    end if;

    v_had_window := false;

    -- a provider may have several windows on the same weekday
    for v_win in
      select start_time, end_time
      from provider_availability
      where provider_id = p_provider_id and day_of_week = v_dow
      order by start_time
    loop
      v_had_window := true;
      v_slot_time := v_win.start_time;

      -- a slot starting at T occupies [T, T + interval]; only emit starts
      -- whose full duration fits inside the window
      while v_slot_time + v_step <= v_win.end_time loop
        v_slot_ts := (v_date::text || ' ' || v_slot_time::text || '+08')::timestamptz;

        if exists (
          select 1 from time_slots
          where provider_id = p_provider_id and slot_datetime = v_slot_ts
        ) then
          v_existing := v_existing + 1;
        else
          v_to_create := v_to_create + 1;
          if not p_dry_run then
            insert into time_slots (provider_id, service_id, slot_datetime)
            values (p_provider_id, p_service_id, v_slot_ts)
            on conflict (provider_id, slot_datetime) do nothing;
          end if;
        end if;

        -- keep a small sample of would-be slot times for the preview
        if jsonb_array_length(v_sample) < 8 then
          v_sample := v_sample || to_jsonb(v_slot_ts);
        end if;

        v_slot_time := v_slot_time + v_step;
      end loop;
    end loop;

    if v_had_window then
      v_avail_days := v_avail_days + 1;
    end if;
  end loop;

  -- audit only a real (committed) generation that wrote something
  if not p_dry_run and v_to_create > 0 then
    insert into audit_log (actor_id, action, target_table, target_id)
    values (auth.uid(), 'generate_time_slots', 'time_slots', p_provider_id);
  end if;

  return jsonb_build_object(
    'dry_run',                p_dry_run,
    'to_create',             v_to_create,
    'already_exist',         v_existing,
    'exception_days',        v_exc_days,
    'days_with_availability', v_avail_days,
    'interval_minutes',      p_interval_minutes,
    'sample',                v_sample
  );
end;
$$;

grant execute on function
  public.generate_time_slots(uuid, uuid, date, date, int, boolean)
  to authenticated;
