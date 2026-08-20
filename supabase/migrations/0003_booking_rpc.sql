-- ============================================================
-- 0003_booking_rpc.sql
-- Race-safe booking RPC + cancel + profile-read policy for booking UI.
--
-- book_appointment uses SELECT ... FOR UPDATE to lock the slot row
-- so two simultaneous calls can never both see is_booked = false.
-- NO client INSERT policy exists on appointments/queue_tickets —
-- this SECURITY DEFINER function is the only write path.
-- ============================================================

-- ------------------------------------------------------------
-- Allow authenticated users to see provider profiles (needed so
-- the booking UI can display doctor names in the slot list).
-- Patients can't read doctor profiles through the current policies.
-- ------------------------------------------------------------
create policy "authenticated: select provider profiles"
  on public.profiles for select to authenticated
  using (
    exists (
      select 1 from public.providers where profile_id = profiles.id
    )
  );

-- ------------------------------------------------------------
-- book_appointment(p_slot_id)
-- Returns: appointment_id, ticket_number, queue_position, qr_code,
--          slot_datetime, provider_id, service_id
-- Raises an exception (caught by the client) if:
--   - Caller is not a patient
--   - Slot does not exist
--   - Slot is already booked
-- ------------------------------------------------------------
create or replace function public.book_appointment(p_slot_id uuid)
returns jsonb
language plpgsql
security definer
-- `extensions` must be on the search_path: gen_random_bytes lives
-- there on Supabase, and a pinned `public`-only path hides it.
set search_path = public, extensions
as $$
declare
  v_patient_id    uuid;
  v_slot          record;
  v_appointment_id uuid;
  v_queue_position int;
  v_ticket_number text;
  v_qr_code       text;
begin
  -- Verify caller is a patient
  select id into v_patient_id
  from patients
  where profile_id = auth.uid();

  if v_patient_id is null then
    raise exception 'ERR_NOT_PATIENT: caller is not a patient account';
  end if;

  -- Lock the slot for this transaction — blocks any concurrent booking
  -- of the same slot until we commit or rollback.
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

  -- Mark slot booked
  update time_slots
  set is_booked = true
  where id = p_slot_id;

  -- Create appointment
  insert into appointments (patient_id, provider_id, service_id, slot_id, status)
  values (v_patient_id, v_slot.provider_id, v_slot.service_id, p_slot_id, 'booked')
  returning id into v_appointment_id;

  -- Queue position = how many tickets already exist for this provider
  -- on this same calendar day (Asia/Manila).
  select coalesce(max(qt.queue_position), 0) + 1 into v_queue_position
  from queue_tickets qt
  join appointments a on a.id = qt.appointment_id
  join time_slots ts on ts.id = a.slot_id
  where a.provider_id = v_slot.provider_id
    and (ts.slot_datetime at time zone 'Asia/Manila')::date
      = (v_slot.slot_datetime at time zone 'Asia/Manila')::date;

  v_ticket_number := 'T' || lpad(v_queue_position::text, 3, '0');
  v_qr_code       := encode(gen_random_bytes(16), 'hex');

  -- Create queue ticket
  insert into queue_tickets (appointment_id, ticket_number, queue_position, qr_code, status)
  values (v_appointment_id, v_ticket_number, v_queue_position, v_qr_code, 'waiting');

  -- Audit
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

-- Grant execute to authenticated users only (anon cannot book)
grant execute on function public.book_appointment(uuid) to authenticated;

-- ------------------------------------------------------------
-- cancel_appointment(p_appointment_id)
-- Patient cancels their own appointment; frees the slot.
-- Staff/admin can also cancel any appointment.
-- ------------------------------------------------------------
create or replace function public.cancel_appointment(p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_appt record;
  v_role text;
begin
  select role into v_role from profiles where id = auth.uid();

  select a.id, a.patient_id, a.slot_id, a.status, pt.profile_id
  into v_appt
  from appointments a
  join patients pt on pt.id = a.patient_id
  where a.id = p_appointment_id;

  if not found then
    raise exception 'ERR_NOT_FOUND: appointment does not exist';
  end if;

  -- Patient can only cancel their own; staff/admin cancel any
  if v_role = 'patient' and v_appt.profile_id <> auth.uid() then
    raise exception 'ERR_FORBIDDEN: cannot cancel another patient''s appointment';
  end if;

  if v_appt.status not in ('booked', 'checked_in') then
    raise exception 'ERR_INVALID_STATUS: cannot cancel a % appointment', v_appt.status;
  end if;

  update appointments set status = 'cancelled' where id = p_appointment_id;
  update time_slots set is_booked = false where id = v_appt.slot_id;

  insert into audit_log (actor_id, action, target_table, target_id)
  values (auth.uid(), 'cancel_appointment', 'appointments', p_appointment_id);
end;
$$;

grant execute on function public.cancel_appointment(uuid) to authenticated;
