-- ============================================================
-- 0038_open_slots_duration_minutes.sql
-- Expose time_slots.duration_minutes through open_slots.
--
-- 0032 recreated open_slots with explicit columns to hide active
-- emergency-reschedule holds. 0037 added time_slots.duration_minutes,
-- but existing views do not auto-expand when a base table gains a column.
-- Keep all existing filters/columns and append duration_minutes.
-- ============================================================

create or replace view public.open_slots
with (security_invoker = true)
as
  select
    ts.id,
    ts.provider_id,
    ts.service_id,
    ts.slot_datetime,
    ts.is_booked,
    ts.held_by_reschedule_proposal_id,
    ts.hold_expires_at,
    ts.duration_minutes
  from public.time_slots ts
  where not ts.is_booked
    and not public.is_exception_slot(ts.provider_id, ts.slot_datetime)
    and (
      ts.held_by_reschedule_proposal_id is null
      or ts.hold_expires_at <= now()
    );

grant select on public.open_slots to authenticated;
