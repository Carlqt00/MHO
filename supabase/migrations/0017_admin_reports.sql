-- ============================================================
-- 0017_admin_reports.sql
-- Aggregate RPCs for the admin/staff Reports page.
--
-- WHY NEW (not just reuse 0012): the 0012 volume RPCs collapse
-- checked_in+served into "attended" and booked into "pending",
-- so they CANNOT give the per-status split (booked / checked_in /
-- served / no_show / cancelled) the summary report needs. The
-- by-service, by-provider, and patient-stats aggregates are new too.
--
-- All group/filter on appointments.appointment_date (Manila date,
-- 0011) so buckets match the calendar and the volume chart.
--
-- SECURITY INVOKER, same as 0012: the caller's RLS applies. The
-- "staff/admin: select all ..." policies (0002) give admin AND staff
-- true totals; other roles are blocked from the page by the route
-- guard. STABLE, search_path=public, EXECUTE to authenticated.
--
-- Idempotent: CREATE OR REPLACE for every function.
-- NOT YET APPLIED (author runs it).
-- ============================================================

-- 1. Appointment summary: one row, count per status + total.
create or replace function public.report_appointment_summary(p_from date, p_to date)
returns table (
  booked int, checked_in int, served int,
  no_show int, cancelled int, total int
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (where status = 'booked')::int,
    count(*) filter (where status = 'checked_in')::int,
    count(*) filter (where status = 'served')::int,
    count(*) filter (where status = 'no_show')::int,
    count(*) filter (where status = 'cancelled')::int,
    count(*)::int
  from public.appointments
  where appointment_date between p_from and p_to;
$$;

grant execute on function public.report_appointment_summary(date, date) to authenticated;

-- 2. By service: appointment count per service, highest first.
create or replace function public.report_by_service(p_from date, p_to date)
returns table (service_name text, count int)
language sql
stable
security invoker
set search_path = public
as $$
  select s.name as service_name, count(*)::int as count
  from public.appointments a
  join public.services s on s.id = a.service_id
  where a.appointment_date between p_from and p_to
  group by s.name
  order by count(*) desc, s.name;
$$;

grant execute on function public.report_by_service(date, date) to authenticated;

-- 3. By provider: appointment count per provider, highest first.
-- appointments.provider_id -> providers.id -> providers.profile_id
-- -> profiles.full_name (NOT appointments.provider_id = profiles.id).
create or replace function public.report_by_provider(p_from date, p_to date)
returns table (provider_name text, count int)
language sql
stable
security invoker
set search_path = public
as $$
  select prof.full_name as provider_name, count(*)::int as count
  from public.appointments a
  join public.providers pv on pv.id = a.provider_id
  join public.profiles prof on prof.id = pv.profile_id
  where a.appointment_date between p_from and p_to
  group by prof.full_name
  order by count(*) desc, prof.full_name;
$$;

grant execute on function public.report_by_provider(date, date) to authenticated;

-- 4. Patient stats: counts only, no names/contacts.
--   total_patients  - all registered patients (all-time)
--   new_patients    - registered within the range
--   active_patients - distinct patients with an appointment in range
create or replace function public.report_patient_stats(p_from date, p_to date)
returns table (total_patients int, new_patients int, active_patients int)
language sql
stable
security invoker
set search_path = public
as $$
  select
    (select count(*) from public.patients)::int,
    (select count(*) from public.patients
       where (created_at at time zone 'Asia/Manila')::date between p_from and p_to)::int,
    (select count(distinct a.patient_id) from public.appointments a
       where a.appointment_date between p_from and p_to)::int;
$$;

grant execute on function public.report_patient_stats(date, date) to authenticated;
