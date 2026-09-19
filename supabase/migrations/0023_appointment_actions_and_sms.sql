-- ============================================================
-- 0021_appointment_actions_and_sms.sql
-- Appointment lifecycle actions that SMS notifications hook into, plus the
-- delivery-tracking columns the iTextMo integration needs.
--
-- 1. reschedule_appointment(p_appointment_id, p_new_slot_id) — move a booked
--    appointment to another open slot of the SAME service. Patient (own
--    booking) or staff/admin. Race-safe like book_appointment: the new slot is
--    locked FOR UPDATE, the old slot is released, and the queue ticket is
--    re-numbered only when the provider or Manila day changes.
-- 2. set_appointment_status(p_appointment_id, p_status) — reception marks a
--    patient checked_in (arrived) or no_show. nurse/staff/admin only.
--    booked → checked_in, booked|checked_in → no_show. no_show closes the
--    queue ticket so the board stops calling that patient.
-- 3. advance_queue now also returns the served + promoted appointment ids so
--    the client can send "thank you" and "you're being called" SMS.
-- 4. notification_logs: provider_message_id (iTextMo msg id, matched by the
--    delivery webhook), event (which flow sent it), announcement_id, and a
--    'delivered' status.
-- 5. announcements: sms_sent_at / sms_recipient_count so the admin can see a
--    broadcast already went out.
-- 6. password_reset_requests: code_attempts — the reset code now travels by
--    SMS, so brute-force attempts on it are counted and capped.
-- ============================================================

-- ------------------------------------------------------------
-- 1. reschedule_appointment
-- ------------------------------------------------------------
create or replace function public.reschedule_appointment(
  p_appointment_id uuid,
  p_new_slot_id    uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role           text;
  v_appt           record;
  v_slot           record;
  v_old_slot_at    timestamptz;
  v_same_queue     boolean;
  v_queue_position int;
  v_ticket_number  text;
  v_ticket         record;
begin
  select role into v_role from profiles where id = auth.uid();

  select a.id, a.patient_id, a.provider_id, a.service_id, a.slot_id, a.status,
         pt.profile_id, ts.slot_datetime as old_slot_at
  into v_appt
  from appointments a
  join patients pt on pt.id = a.patient_id
  join time_slots ts on ts.id = a.slot_id
  where a.id = p_appointment_id
  for update of a;

  if not found then
    raise exception 'ERR_NOT_FOUND: appointment does not exist';
  end if;

  if v_role = 'patient' and v_appt.profile_id <> auth.uid() then
    raise exception 'ERR_FORBIDDEN: cannot reschedule another patient''s appointment';
  end if;
  if v_role not in ('patient', 'staff', 'admin') then
    raise exception 'ERR_FORBIDDEN: only the patient or clinic staff can reschedule';
  end if;

  if v_appt.status <> 'booked' then
    raise exception 'ERR_INVALID_STATUS: cannot reschedule a % appointment', v_appt.status;
  end if;

  if v_appt.slot_id = p_new_slot_id then
    raise exception 'ERR_SAME_SLOT: appointment is already on this slot';
  end if;

  -- Lock the target slot for this transaction (same pattern as book_appointment)
  select ts.id, ts.provider_id, ts.service_id, ts.slot_datetime, ts.is_booked
  into v_slot
  from time_slots ts
  where ts.id = p_new_slot_id
  for update;

  if not found then
    raise exception 'ERR_NOT_FOUND: slot does not exist';
  end if;
  if v_slot.is_booked then
    raise exception 'ERR_ALREADY_BOOKED: this slot has just been taken';
  end if;
  if v_slot.service_id <> v_appt.service_id then
    raise exception 'ERR_SERVICE_MISMATCH: new slot is for a different service';
  end if;
  if v_slot.slot_datetime <= now() then
    raise exception 'ERR_SLOT_PAST: cannot move to a time that has already passed';
  end if;
  if public.is_exception_slot(v_slot.provider_id, v_slot.slot_datetime) then
    raise exception 'ERR_ON_EXCEPTION_DATE: slot is on a leave or holiday date';
  end if;

  v_old_slot_at := v_appt.old_slot_at;

  -- Swap the slots
  update time_slots set is_booked = false where id = v_appt.slot_id;
  update time_slots set is_booked = true  where id = p_new_slot_id;

  update appointments
  set slot_id          = p_new_slot_id,
      provider_id      = v_slot.provider_id,
      appointment_at   = v_slot.slot_datetime,
      appointment_date = (v_slot.slot_datetime at time zone 'Asia/Manila')::date
  where id = p_appointment_id;

  -- Queue ticket: keep number/position when the provider and Manila day are
  -- unchanged (the patient keeps their place); otherwise issue the next
  -- position for the new provider/day, excluding this ticket itself.
  v_same_queue :=
    v_slot.provider_id = v_appt.provider_id
    and (v_slot.slot_datetime at time zone 'Asia/Manila')::date
      = (v_old_slot_at at time zone 'Asia/Manila')::date;

  if not v_same_queue then
    select coalesce(max(qt.queue_position), 0) + 1 into v_queue_position
    from queue_tickets qt
    join appointments a on a.id = qt.appointment_id
    join time_slots ts on ts.id = a.slot_id
    where a.provider_id = v_slot.provider_id
      and qt.appointment_id <> p_appointment_id
      and (ts.slot_datetime at time zone 'Asia/Manila')::date
        = (v_slot.slot_datetime at time zone 'Asia/Manila')::date;

    v_ticket_number := 'T' || lpad(v_queue_position::text, 3, '0');

    update queue_tickets
    set queue_position = v_queue_position,
        ticket_number  = v_ticket_number,
        status         = 'waiting'
    where appointment_id = p_appointment_id;
  end if;

  select ticket_number, queue_position, qr_code
  into v_ticket
  from queue_tickets
  where appointment_id = p_appointment_id;

  insert into audit_log (actor_id, action, target_table, target_id)
  values (auth.uid(), 'reschedule_appointment', 'appointments', p_appointment_id);

  return jsonb_build_object(
    'appointment_id',         p_appointment_id,
    'previous_slot_datetime', v_old_slot_at,
    'slot_datetime',          v_slot.slot_datetime,
    'provider_id',            v_slot.provider_id,
    'ticket_number',          v_ticket.ticket_number,
    'queue_position',         v_ticket.queue_position,
    'qr_code',                v_ticket.qr_code
  );
end;
$$;

grant execute on function public.reschedule_appointment(uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- 2. set_appointment_status — check-in / no-show at reception
-- ------------------------------------------------------------
create or replace function public.set_appointment_status(
  p_appointment_id uuid,
  p_status         text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role   text;
  v_status text;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role not in ('nurse', 'staff', 'admin') then
    raise exception 'ERR_FORBIDDEN: only clinic personnel can update appointment status';
  end if;

  if p_status not in ('checked_in', 'no_show') then
    raise exception 'ERR_INVALID_STATUS: unsupported target status %', p_status;
  end if;

  select status into v_status from appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'ERR_NOT_FOUND: appointment does not exist';
  end if;

  if p_status = 'checked_in' and v_status <> 'booked' then
    raise exception 'ERR_INVALID_STATUS: cannot check in a % appointment', v_status;
  end if;
  if p_status = 'no_show' and v_status not in ('booked', 'checked_in') then
    raise exception 'ERR_INVALID_STATUS: cannot mark a % appointment as no-show', v_status;
  end if;

  update appointments set status = p_status where id = p_appointment_id;

  -- A no-show leaves the queue; a check-in keeps the ticket waiting.
  if p_status = 'no_show' then
    update queue_tickets
    set status = 'done'
    where appointment_id = p_appointment_id
      and status in ('waiting', 'now_serving');
  end if;

  insert into audit_log (actor_id, action, target_table, target_id)
  values (auth.uid(), 'set_appointment_status:' || p_status, 'appointments', p_appointment_id);
end;
$$;

grant execute on function public.set_appointment_status(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 3. advance_queue — also report the appointment ids involved
-- ------------------------------------------------------------
create or replace function public.advance_queue(p_provider_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role    text;
  v_current record;
  v_next    record;
  v_served  uuid;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role not in ('nurse', 'staff', 'admin') then
    raise exception 'ERR_FORBIDDEN: only clinic personnel can advance the queue';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_provider_id::text, 0));

  select qt.id, qt.appointment_id
  into v_current
  from queue_tickets qt
  join appointments a on a.id = qt.appointment_id
  join time_slots ts on ts.id = a.slot_id
  where a.provider_id = p_provider_id
    and qt.status = 'now_serving'
    and (ts.slot_datetime at time zone 'Asia/Manila')::date
      = (now() at time zone 'Asia/Manila')::date
  order by qt.queue_position
  limit 1;

  if found then
    update queue_tickets set status = 'done' where id = v_current.id;
    update appointments set status = 'served' where id = v_current.appointment_id;
    v_served := v_current.appointment_id;
  end if;

  select qt.id, qt.ticket_number, qt.queue_position, qt.appointment_id
  into v_next
  from queue_tickets qt
  join appointments a on a.id = qt.appointment_id
  join time_slots ts on ts.id = a.slot_id
  where a.provider_id = p_provider_id
    and qt.status = 'waiting'
    and a.status in ('booked', 'checked_in')
    and (ts.slot_datetime at time zone 'Asia/Manila')::date
      = (now() at time zone 'Asia/Manila')::date
  order by qt.queue_position
  limit 1;

  if not found then
    -- Queue empty: still report who was just served so the client can notify.
    if v_served is null then
      return null;
    end if;
    return jsonb_build_object('served_appointment_id', v_served);
  end if;

  update queue_tickets set status = 'now_serving' where id = v_next.id;

  insert into audit_log (actor_id, action, target_table, target_id)
  values (auth.uid(), 'advance_queue', 'queue_tickets', v_next.id);

  return jsonb_build_object(
    'ticket_id',             v_next.id,
    'ticket_number',         v_next.ticket_number,
    'queue_position',        v_next.queue_position,
    'appointment_id',        v_next.appointment_id,
    'served_appointment_id', v_served
  );
end;
$$;

-- ------------------------------------------------------------
-- 3b. list_exception_appointments — also return service_id so the admin can
--     reschedule a stranded appointment (open slots are looked up per
--     service). Return columns change, so drop + recreate.
-- ------------------------------------------------------------
drop function if exists public.list_exception_appointments(uuid, date);

create function public.list_exception_appointments(
  p_provider_id uuid,
  p_date        date
)
returns table (
  appointment_id uuid,
  patient_name   text,
  service_name   text,
  provider_name  text,
  slot_datetime  timestamptz,
  status         text,
  service_id     uuid
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
      a.status,
      a.service_id
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

-- ------------------------------------------------------------
-- 4. notification_logs — delivery tracking
-- ------------------------------------------------------------
alter table public.notification_logs
  add column if not exists provider_message_id text,
  add column if not exists event text,
  add column if not exists announcement_id uuid references public.announcements (id) on delete set null;

do $$
declare
  v_constraint_name text;
begin
  select conname into v_constraint_name
  from pg_constraint
  where conrelid = 'public.notification_logs'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%status%'
    and pg_get_constraintdef(oid) like '%pending%'
  limit 1;

  if v_constraint_name is not null then
    execute format('alter table public.notification_logs drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table public.notification_logs
  add constraint notification_logs_status_chk
  check (status in ('pending', 'sent', 'delivered', 'failed'));

create index if not exists idx_notification_logs_provider_message_id
  on public.notification_logs (provider_message_id)
  where provider_message_id is not null;

create index if not exists idx_notification_logs_announcement
  on public.notification_logs (announcement_id)
  where announcement_id is not null;

-- ------------------------------------------------------------
-- 5. announcements — broadcast bookkeeping
-- ------------------------------------------------------------
alter table public.announcements
  add column if not exists sms_sent_at timestamptz,
  add column if not exists sms_recipient_count integer;

-- ------------------------------------------------------------
-- 6. password_reset_requests — SMS code attempt counter
-- ------------------------------------------------------------
alter table public.password_reset_requests
  add column if not exists code_attempts integer not null default 0;
