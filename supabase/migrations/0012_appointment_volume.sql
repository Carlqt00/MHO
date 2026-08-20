-- ============================================================
-- 0012_appointment_volume.sql
-- Descriptive analytics for the admin Overview patient-volume chart.
-- Four aggregate RPCs (one per granularity) return status counts grouped
-- by period. NO forecasting — plain aggregation of past bookings.
--
-- SCHEMA FACTS this migration relies on (verified against 0001 / 0011):
--   * appointments.status is TEXT, CHECK-limited to
--     ('booked','checked_in','served','cancelled','no_show').
--   * appointments.appointment_date is the stored Manila calendar date
--     (added in 0011, RPC-populated). We group by THIS column — never a
--     re-derivation of appointment_at — so the buckets match the booking
--     guards and the calendar.
--
-- Segment definitions (bottom→top in the UI):
--   attended  = status in ('checked_in','served')
--   no_show   = status  = 'no_show'
--   cancelled = status  = 'cancelled'
--   pending   = status  = 'booked'
--   total     = every row in the period, regardless of status (= demand)
--
-- SECURITY INVOKER (same as service_daily_availability in 0011): the
-- caller's RLS applies. The admin "staff/admin: select all appointments"
-- policy (0002) exposes every row incl. cancelled, so an admin gets true
-- totals; a non-admin caller would only ever aggregate their own rows.
--
-- Idempotent / re-runnable: CREATE OR REPLACE for every function.
-- APPLIED & VERIFIED 2026-08-20 — all four RPCs exist with
-- has_function_privilege(..., 'EXECUTE') = true for authenticated.
-- ============================================================

-- ------------------------------------------------------------
-- Day: one bucket per Manila calendar date.
-- ------------------------------------------------------------
create or replace function public.appointment_volume_by_day(p_from date, p_to date)
returns table (period date, attended int, no_show int, cancelled int, pending int, total int)
language sql
stable
security invoker
set search_path = public
as $$
  select a.appointment_date as period,
         count(*) filter (where a.status in ('checked_in','served'))::int as attended,
         count(*) filter (where a.status = 'no_show')::int                as no_show,
         count(*) filter (where a.status = 'cancelled')::int              as cancelled,
         count(*) filter (where a.status = 'booked')::int                 as pending,
         count(*)::int                                                    as total
  from public.appointments a
  where a.appointment_date between p_from and p_to
  group by a.appointment_date
  order by a.appointment_date;
$$;

grant execute on function public.appointment_volume_by_day(date, date) to authenticated;

-- ------------------------------------------------------------
-- Week: ISO week (Monday start) via date_trunc, cast back to date.
-- ------------------------------------------------------------
create or replace function public.appointment_volume_by_week(p_from date, p_to date)
returns table (period date, attended int, no_show int, cancelled int, pending int, total int)
language sql
stable
security invoker
set search_path = public
as $$
  select date_trunc('week', a.appointment_date)::date as period,
         count(*) filter (where a.status in ('checked_in','served'))::int as attended,
         count(*) filter (where a.status = 'no_show')::int                as no_show,
         count(*) filter (where a.status = 'cancelled')::int              as cancelled,
         count(*) filter (where a.status = 'booked')::int                 as pending,
         count(*)::int                                                    as total
  from public.appointments a
  where a.appointment_date between p_from and p_to
  group by 1
  order by 1;
$$;

grant execute on function public.appointment_volume_by_week(date, date) to authenticated;

-- ------------------------------------------------------------
-- Month: first-of-month bucket.
-- ------------------------------------------------------------
create or replace function public.appointment_volume_by_month(p_from date, p_to date)
returns table (period date, attended int, no_show int, cancelled int, pending int, total int)
language sql
stable
security invoker
set search_path = public
as $$
  select date_trunc('month', a.appointment_date)::date as period,
         count(*) filter (where a.status in ('checked_in','served'))::int as attended,
         count(*) filter (where a.status = 'no_show')::int                as no_show,
         count(*) filter (where a.status = 'cancelled')::int              as cancelled,
         count(*) filter (where a.status = 'booked')::int                 as pending,
         count(*)::int                                                    as total
  from public.appointments a
  where a.appointment_date between p_from and p_to
  group by 1
  order by 1;
$$;

grant execute on function public.appointment_volume_by_month(date, date) to authenticated;

-- ------------------------------------------------------------
-- Year: first-of-year bucket.
-- ------------------------------------------------------------
create or replace function public.appointment_volume_by_year(p_from date, p_to date)
returns table (period date, attended int, no_show int, cancelled int, pending int, total int)
language sql
stable
security invoker
set search_path = public
as $$
  select date_trunc('year', a.appointment_date)::date as period,
         count(*) filter (where a.status in ('checked_in','served'))::int as attended,
         count(*) filter (where a.status = 'no_show')::int                as no_show,
         count(*) filter (where a.status = 'cancelled')::int              as cancelled,
         count(*) filter (where a.status = 'booked')::int                 as pending,
         count(*)::int                                                    as total
  from public.appointments a
  where a.appointment_date between p_from and p_to
  group by 1
  order by 1;
$$;

grant execute on function public.appointment_volume_by_year(date, date) to authenticated;
