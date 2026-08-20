-- ============================================================
-- 0013_service_daily_slot_status.sql
-- Richer per-day availability for the patient booking calendar, so three
-- distinct "cannot book" states can be told apart instead of all reading
-- "Puno" (full):
--   no slots exist for the service that day    → "Walang schedule"
--   slots exist but every one is booked         → "Puno"
--   slots exist & unbooked but their times have → "Lipas na"
--     already passed (today only)
--
-- Supersedes service_daily_availability (0011) FOR THE CALENDAR: that
-- function returned ONLY the open-and-upcoming count (`remaining`), which
-- collapses all three states above to remaining = 0. This one returns the
-- extra counts the client needs to distinguish them. 0011's function is
-- left in place (harmless) and may be dropped once nothing calls it.
--
-- Same conventions as 0011: language sql, STABLE, SECURITY INVOKER
-- (patients have `authenticated: select time slots USING (true)` in 0002,
-- so the invoker sees every slot), search_path = public, granted to
-- authenticated. Exception-date slots are EXCLUDED (not is_exception_slot,
-- 0009) so a leave/holiday reads as "Walang schedule", matching the
-- hidden-not-deleted rule. `remaining` keeps the `slot_datetime >= now()`
-- filter, so a 9:00 AM slot nobody booked is NOT counted as available at
-- 2:30 PM.
--
-- Columns per Manila day (only days that have >= 1 non-exception slot appear):
--   remaining — unbooked AND slot_datetime >= now()   (actually bookable now)
--   unbooked  — unbooked, any time                     (past + upcoming)
--   upcoming  — any slot with slot_datetime >= now()   (booked or not)
--   total     — every non-exception slot that day      (booked + unbooked)
--
-- Client label logic (see BookAppointment.tsx unavailableLabel):
--   no row / total = 0 → Walang schedule   (service not offered that day)
--   remaining > 0      → available          (show the remaining count)
--   upcoming > 0       → Puno               (upcoming slots exist, all booked)
--   unbooked > 0       → Lipas na           (open slots existed, times passed)
--   else               → Puno               (all booked)
--
-- Idempotent (CREATE OR REPLACE). NOT YET APPLIED — the author runs this.
-- ============================================================

create or replace function public.service_daily_slot_status(
  p_service_id uuid,
  p_from       date,
  p_to         date
)
returns table (day date, remaining int, unbooked int, upcoming int, total int)
language sql
stable
security invoker
set search_path = public
as $$
  select (ts.slot_datetime at time zone 'Asia/Manila')::date as day,
         count(*) filter (where not ts.is_booked and ts.slot_datetime >= now())::int as remaining,
         count(*) filter (where not ts.is_booked)::int                               as unbooked,
         count(*) filter (where ts.slot_datetime >= now())::int                      as upcoming,
         count(*)::int                                                               as total
  from public.time_slots ts
  where ts.service_id = p_service_id
    and (ts.slot_datetime at time zone 'Asia/Manila')::date between p_from and p_to
    and not public.is_exception_slot(ts.provider_id, ts.slot_datetime)
  group by 1
  order by 1;
$$;

grant execute on function public.service_daily_slot_status(uuid, date, date) to authenticated;
