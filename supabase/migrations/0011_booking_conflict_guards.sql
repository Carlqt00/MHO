-- ============================================================
-- 0011_booking_conflict_guards.sql
-- Two per-patient booking guards + calendar availability support for
-- the 4-step booking flow (Service → Date → Time → Confirm).
--
-- SCHEMA FACTS this migration relies on (verified against 0001):
--   * appointments.status is a TEXT column (not an enum), CHECK-limited
--     to ('booked','checked_in','served','cancelled','no_show').
--     The cancelled value is spelled 'cancelled' (double-l).
--   * The booking date/time lived only on time_slots.slot_datetime; there
--     was no date column on appointments to index. We add two stored,
--     RPC-populated columns so the partial unique indexes below have real
--     columns to key on.
--
-- Both guards EXCLUDE cancelled rows (WHERE status <> 'cancelled') — a
-- patient who cancels must be able to rebook the same service/date or
-- time. Same predicate as the existing uniq_active_appointment_per_slot.
--
-- Idempotent / re-runnable: ADD COLUMN IF NOT EXISTS, a backfill that
-- only fills NULLs, CREATE UNIQUE INDEX IF NOT EXISTS, and CREATE OR
-- REPLACE for the functions. Safe to run more than once.
-- APPLIED & VERIFIED 2026-08-21 — appointment_at + appointment_date columns
-- exist on appointments, both partial unique indexes
-- (uniq_active_service_per_patient_day, uniq_active_time_per_patient) exist,
-- and service_daily_availability exists.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Stored booking date/time on appointments.
--   appointment_at   — the slot's exact instant (guard b: time conflict
--                       across DIFFERENT services/providers at the same
--                       moment, which same-slot uniqueness can't catch).
--   appointment_date — the Manila calendar date (guard a: same service,
--                       same day). Cannot be a GENERATED column because
--                       the timezone cast is STABLE, not IMMUTABLE, so
--                       it is populated by the RPC / backfill instead.
-- Canonical Manila cast matches 0003 / 0007 / 0009.
-- ------------------------------------------------------------
alter table public.appointments
  add column if not exists appointment_at   timestamptz,
  add column if not exists appointment_date date;

-- Backfill existing rows from their slot (only where still NULL, so a
-- re-run is a no-op). slot_id is a NOT NULL FK, so every row resolves.
update public.appointments a
set appointment_at   = ts.slot_datetime,
    appointment_date = (ts.slot_datetime at time zone 'Asia/Manila')::date
from public.time_slots ts
where ts.id = a.slot_id
  and (a.appointment_at is null or a.appointment_date is null);

-- Every appointment now has both — enforce it going forward. Setting
-- NOT NULL on an already-NOT NULL column is a no-op, so this is idempotent.
alter table public.appointments
  alter column appointment_at   set not null,
  alter column appointment_date set not null;

-- ------------------------------------------------------------
-- 2. Guard (a): one active booking per (patient, service, day).
--    A patient MAY book different services on the same day, but not the
--    same service twice.
-- ------------------------------------------------------------
create unique index if not exists uniq_active_service_per_patient_day
  on public.appointments (patient_id, service_id, appointment_date)
  where status <> 'cancelled';

-- ------------------------------------------------------------
-- 2. Guard (b): one active booking per (patient, exact time).
--    Blocks holding two bookings at the same instant even for different
--    services (e.g. dental 9:00 + check-up 9:00) — physically impossible
--    and it corrupts that day's queue data.
-- ------------------------------------------------------------
create unique index if not exists uniq_active_time_per_patient
  on public.appointments (patient_id, appointment_at)
  where status <> 'cancelled';

-- ------------------------------------------------------------
-- 3. book_appointment — unchanged from 0009 EXCEPT the appointment insert
--    now also writes appointment_at + appointment_date, so the two guards
--    above have their key columns. The new partial unique indexes raise
--    23505 here on a conflict; that rolls back the whole function (slot
--    is_booked reverts), and the client maps the index name to a friendly
--    message (see errors.ts CONSTRAINT_MESSAGES).
-- ------------------------------------------------------------
create or replace function public.book_appointment(p_slot_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_patient_id     uuid;
  v_slot           record;
  v_appointment_id uuid;
  v_queue_position int;
  v_ticket_number  text;
  v_qr_code        text;
begin
  -- Verify caller is a patient
  select id into v_patient_id
  from patients
  where profile_id = auth.uid();

  if v_patient_id is null then
    raise exception 'ERR_NOT_PATIENT: caller is not a patient account';
  end if;

  -- Lock the slot for this transaction
  select ts.id, ts.provider_id, ts.service_id, ts.slot_datetime, ts.is_booked
  into v_slot
  from time_slots ts
  where ts.id = p_slot_id
  for update;

  if not found then
    raise exception 'ERR_NOT_FOUND: slot does not exist';
  end if;

  if v_slot.is_booked then
    raise exception 'ERR_ALREADY_BOOKED: this slot has just been taken';
  end if;

  -- Block booking on a date that became a provider leave or a clinic-wide
  -- holiday after this slot was generated (same predicate as open_slots).
  if public.is_exception_slot(v_slot.provider_id, v_slot.slot_datetime) then
    raise exception 'ERR_ON_EXCEPTION_DATE: slot is on a leave or holiday date';
  end if;

  -- Mark slot booked
  update time_slots
  set is_booked = true
  where id = p_slot_id;

  -- Create appointment. appointment_at / appointment_date drive the
  -- per-patient booking guards (0011).
  insert into appointments (
    patient_id, provider_id, service_id, slot_id, status,
    appointment_at, appointment_date
  )
  values (
    v_patient_id, v_slot.provider_id, v_slot.service_id, p_slot_id, 'booked',
    v_slot.slot_datetime,
    (v_slot.slot_datetime at time zone 'Asia/Manila')::date
  )
  returning id into v_appointment_id;

  -- Queue position = tickets already issued for this provider on this
  -- same calendar day (Asia/Manila).
  select coalesce(max(qt.queue_position), 0) + 1 into v_queue_position
  from queue_tickets qt
  join appointments a on a.id = qt.appointment_id
  join time_slots ts on ts.id = a.slot_id
  where a.provider_id = v_slot.provider_id
    and (ts.slot_datetime at time zone 'Asia/Manila')::date
      = (v_slot.slot_datetime at time zone 'Asia/Manila')::date;

  v_ticket_number := 'T' || lpad(v_queue_position::text, 3, '0');
  v_qr_code       := encode(gen_random_bytes(16), 'hex');

  insert into queue_tickets (appointment_id, ticket_number, queue_position, qr_code, status)
  values (v_appointment_id, v_ticket_number, v_queue_position, v_qr_code, 'waiting');

  insert into audit_log (actor_id, action, target_table, target_id)
  values (auth.uid(), 'book_appointment', 'appointments', v_appointment_id);

  return jsonb_build_object(
    'appointment_id',  v_appointment_id,
    'ticket_number',   v_ticket_number,
    'queue_position',  v_queue_position,
    'qr_code',         v_qr_code,
    'slot_datetime',   v_slot.slot_datetime,
    'provider_id',     v_slot.provider_id,
    'service_id',      v_slot.service_id
  );
end;
$$;

grant execute on function public.book_appointment(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. service_daily_availability — ONE aggregate query backing the month
--    calendar. Counts remaining OPEN slots per Manila day for a service,
--    across every provider that offers it. Reads open_slots (already
--    excludes booked slots AND exception dates), so the count matches
--    what the time step will actually show. slot_datetime >= now() keeps
--    today's count consistent with fetchOpenSlots' future-only filter.
--    SECURITY INVOKER: open_slots is a security_invoker view, so the
--    caller's RLS on time_slots applies.
-- ------------------------------------------------------------
create or replace function public.service_daily_availability(
  p_service_id uuid,
  p_from       date,
  p_to         date
)
returns table (day date, remaining int)
language sql
stable
security invoker
set search_path = public
as $$
  select (os.slot_datetime at time zone 'Asia/Manila')::date as day,
         count(*)::int as remaining
  from public.open_slots os
  where os.service_id = p_service_id
    and os.slot_datetime >= now()
    and (os.slot_datetime at time zone 'Asia/Manila')::date between p_from and p_to
  group by 1
  order by 1;
$$;

grant execute on function public.service_daily_availability(uuid, date, date) to authenticated;
