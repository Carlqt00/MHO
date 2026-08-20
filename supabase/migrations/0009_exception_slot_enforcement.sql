-- ============================================================
-- 0009_exception_slot_enforcement.sql
-- Enforce provider_time_off at READ and BOOK time — not only at
-- generation time. Leave/holidays are usually filed AFTER slots exist,
-- so slots already on the table must stop being bookable the moment an
-- exception is added.
--
-- Strategy: ONE predicate (is_exception_slot) is called by BOTH the
-- open-slots read view and the book_appointment guard, so the list a
-- patient sees and the write path can never drift apart. Unbooked slots
-- are HIDDEN (not deleted), so removing the exception makes them bookable
-- again with no regeneration.
--
-- Manila convention: canonical cast (slot_datetime at time zone
-- 'Asia/Manila')::date — identical to 0003 (booking) and 0007 (queue).
-- ============================================================

-- ------------------------------------------------------------
-- Shared predicate: is this slot on an excepted date?
-- (personal leave when provider_id matches; clinic-wide holiday when
-- the time-off row's provider_id is NULL)
-- ------------------------------------------------------------
create or replace function public.is_exception_slot(
  p_provider_id   uuid,
  p_slot_datetime timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.provider_time_off t
    where t.exception_date = (p_slot_datetime at time zone 'Asia/Manila')::date
      and (t.provider_id = p_provider_id or t.provider_id is null)
  )
$$;

grant execute on function public.is_exception_slot(uuid, timestamptz) to authenticated;

-- ------------------------------------------------------------
-- Read path: open_slots view — bookable = not booked AND not on an
-- exception date. security_invoker so the caller's RLS on time_slots
-- still applies. Projects time_slots 1:1 so PostgREST can still embed
-- providers/services through it.
-- ------------------------------------------------------------
create or replace view public.open_slots
  with (security_invoker = true)
as
  select ts.*
  from public.time_slots ts
  where ts.is_booked = false
    and not public.is_exception_slot(ts.provider_id, ts.slot_datetime);

grant select on public.open_slots to authenticated;

-- ------------------------------------------------------------
-- Book path: recreate book_appointment (unchanged from 0003) with ONE
-- added guard — the SAME predicate the view uses. The list filter is
-- UX; THIS is the enforcement (a client can call the RPC directly).
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

  -- NEW: block booking on a date that became a provider leave or a
  -- clinic-wide holiday after this slot was generated. Same predicate as
  -- the open_slots view, so hidden slots are genuinely unbookable.
  if public.is_exception_slot(v_slot.provider_id, v_slot.slot_datetime) then
    raise exception 'ERR_ON_EXCEPTION_DATE: slot is on a leave or holiday date';
  end if;

  -- Mark slot booked
  update time_slots
  set is_booked = true
  where id = p_slot_id;

  -- Create appointment
  insert into appointments (patient_id, provider_id, service_id, slot_id, status)
  values (v_patient_id, v_slot.provider_id, v_slot.service_id, p_slot_id, 'booked')
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
-- Admin: active appointments that would be stranded by an exception on
-- a given date. ONE query drives BOTH the pre-warn count and the
-- post-commit list, so the number matches before and after.
--   p_provider_id NULL  → clinic-wide (all providers on that date)
--   p_provider_id set   → that provider only
-- Same Manila cast as the predicate. Admin-only (SECURITY DEFINER
-- exposes patient names, so guard explicitly).
-- ------------------------------------------------------------
create or replace function public.list_exception_appointments(
  p_provider_id uuid,
  p_date        date
)
returns table (
  appointment_id uuid,
  patient_name   text,
  service_name   text,
  provider_name  text,
  slot_datetime  timestamptz,
  status         text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'ERR_FORBIDDEN: administrator access required';
  end if;

  return query
    select
      a.id,
      pp.full_name,
      s.name,
      provp.full_name,
      ts.slot_datetime,
      a.status
    from appointments a
    join time_slots ts   on ts.id = a.slot_id
    join patients pt     on pt.id = a.patient_id
    join profiles pp     on pp.id = pt.profile_id
    join services s      on s.id = a.service_id
    join providers prov  on prov.id = a.provider_id
    join profiles provp  on provp.id = prov.profile_id
    where a.status in ('booked', 'checked_in')
      and (ts.slot_datetime at time zone 'Asia/Manila')::date = p_date
      and (p_provider_id is null or a.provider_id = p_provider_id)
    order by ts.slot_datetime;
end;
$$;

grant execute on function public.list_exception_appointments(uuid, date) to authenticated;
