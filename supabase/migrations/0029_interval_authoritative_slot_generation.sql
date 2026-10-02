-- ============================================================
-- 0029_interval_authoritative_slot_generation.sql
-- Make generate_time_slots reconcile future unbooked slots to the
-- administrator's configured interval.
--
-- Root fix:
--   Older generate_time_slots was insert-only. Changing 30 -> 25 minutes
--   left the old unbooked 30-minute slots in place, so patients saw a mixed
--   schedule. This version computes the authoritative interval sequence,
--   removes only safe stale future unbooked slots for the selected
--   provider/service/range, and then inserts missing desired slots.
--
-- Safety:
--   Never deletes booked slots.
--   Never deletes any slot referenced by an appointment, regardless of the
--   appointment status.
--   Still skips provider leave / clinic holidays.
-- ============================================================

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
  v_desired     timestamptz[] := array[]::timestamptz[];
  v_stale       int := 0;
  v_range_start timestamptz;
  v_range_end   timestamptz;
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

  v_range_start := (p_from::text || ' 00:00:00+08')::timestamptz;
  v_range_end := ((p_to + 1)::text || ' 00:00:00+08')::timestamptz;

  -- ---- build the authoritative desired interval sequence ----
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

    -- a provider may have several windows on the same weekday. The interval
    -- sequence restarts at the beginning of each separate window.
    for v_win in
      select start_time, end_time
      from provider_availability
      where provider_id = p_provider_id and day_of_week = v_dow
      order by start_time
    loop
      v_had_window := true;
      v_slot_time := v_win.start_time;

      -- The configured interval is the source of truth:
      -- slot_0 = window start; slot_n+1 = slot_n + interval.
      -- A slot is valid while its START is inside the availability window.
      while v_slot_time < v_win.end_time loop
        v_slot_ts := (v_date::text || ' ' || v_slot_time::text || '+08')::timestamptz;
        v_desired := array_append(v_desired, v_slot_ts);

        -- keep a small sample of the true desired sequence for preview/result
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

  -- Existing desired slots are counted by provider/time because the schema's
  -- unique constraint intentionally prevents a provider from exposing two
  -- simultaneous bookable slots, even for different services.
  select count(*)::int
  into v_existing
  from unnest(v_desired) desired(slot_datetime)
  where exists (
    select 1
    from time_slots ts
    where ts.provider_id = p_provider_id
      and ts.slot_datetime = desired.slot_datetime
  );

  select count(*)::int
  into v_to_create
  from unnest(v_desired) desired(slot_datetime)
  where not exists (
    select 1
    from time_slots ts
    where ts.provider_id = p_provider_id
      and ts.slot_datetime = desired.slot_datetime
  );

  -- Count safe stale future slots for this provider/service/range: unbooked,
  -- not linked to any appointment, and not part of the desired interval set.
  select count(*)::int
  into v_stale
  from time_slots ts
  where ts.provider_id = p_provider_id
    and ts.service_id = p_service_id
    and ts.slot_datetime >= greatest(v_range_start, now())
    and ts.slot_datetime < v_range_end
    and not ts.is_booked
    and not exists (
      select 1 from appointments a where a.slot_id = ts.id
    )
    and not (ts.slot_datetime = any(v_desired));

  if not p_dry_run then
    delete from time_slots ts
    where ts.provider_id = p_provider_id
      and ts.service_id = p_service_id
      and ts.slot_datetime >= greatest(v_range_start, now())
      and ts.slot_datetime < v_range_end
      and not ts.is_booked
      and not exists (
        select 1 from appointments a where a.slot_id = ts.id
      )
      and not (ts.slot_datetime = any(v_desired));

    insert into time_slots (provider_id, service_id, slot_datetime)
    select p_provider_id, p_service_id, desired.slot_datetime
    from unnest(v_desired) desired(slot_datetime)
    where not exists (
      select 1
      from time_slots ts
      where ts.provider_id = p_provider_id
        and ts.slot_datetime = desired.slot_datetime
    )
    on conflict (provider_id, slot_datetime) do nothing;
  end if;

  -- audit only a real (committed) generation that changed something
  if not p_dry_run and (v_to_create > 0 or v_stale > 0) then
    insert into audit_log (actor_id, action, target_table, target_id)
    values (auth.uid(), 'generate_time_slots', 'time_slots', p_provider_id);
  end if;

  return jsonb_build_object(
    'dry_run',                p_dry_run,
    'to_create',             v_to_create,
    'already_exist',         v_existing,
    'stale_unbooked_removed', v_stale,
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
