-- ============================================================
-- 0035_checked_in_emergency_reschedules.sql
-- Allow provider-emergency proposals for checked-in patients who
-- are still waiting, while protecting active now-serving visits.
-- ============================================================

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
  service_id     uuid,
  queue_status   text,
  emergency_reschedule_blocked boolean
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
      a.service_id,
      qt.status,
      (qt.status = 'now_serving') as emergency_reschedule_blocked
    from public.appointments a
    join public.time_slots ts on ts.id = a.slot_id
    join public.patients pt on pt.id = a.patient_id
    join public.profiles pp on pp.id = pt.profile_id
    join public.services s on s.id = a.service_id
    join public.providers prov on prov.id = a.provider_id
    join public.profiles provp on provp.id = prov.profile_id
    left join public.queue_tickets qt on qt.appointment_id = a.id
    where a.status in ('booked', 'checked_in')
      and (ts.slot_datetime at time zone 'Asia/Manila')::date = p_date
      and (p_provider_id is null or a.provider_id = p_provider_id)
      and not exists (
        select 1
        from public.appointment_reschedule_proposals arp
        where arp.appointment_id = a.id
          and arp.status = 'pending'
          and arp.token_expires_at > now()
      )
    order by ts.slot_datetime;
end;
$$;

grant execute on function public.list_exception_appointments(uuid, date) to authenticated;

create or replace function public.admin_create_reschedule_proposal(
  p_appointment_id uuid,
  p_proposed_slot_id uuid,
  p_reason text,
  p_token_hash text,
  p_token_expires_at timestamptz,
  p_response_code_hash text,
  p_response_code_expires_at timestamptz
)
returns table (
  proposal_id uuid,
  appointment_id uuid,
  patient_id uuid,
  patient_phone text,
  patient_name text,
  service_name text,
  provider_name text,
  original_appointment_at timestamptz,
  proposed_appointment_at timestamptz,
  reason text,
  token_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_appt record;
  v_slot record;
  v_queue record;
  v_proposal_id uuid;
begin
  if not public.is_admin() then
    raise exception 'ERR_FORBIDDEN: administrator access required';
  end if;

  perform public.release_expired_reschedule_proposals(200);

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'ERR_REASON_REQUIRED: reason is required';
  end if;

  if p_token_expires_at <= now() or p_response_code_expires_at <= now() then
    raise exception 'ERR_INVALID_EXPIRY: response expiry must be in the future';
  end if;

  if nullif(trim(coalesce(p_response_code_hash, '')), '') is null then
    raise exception 'ERR_RESPONSE_CODE_REQUIRED: response code hash is required';
  end if;

  select
    a.id, a.patient_id, a.provider_id, a.service_id, a.slot_id, a.status,
    a.appointment_at, pt.profile_id, pp.full_name as patient_name, pp.phone as patient_phone,
    s.name as service_name, provp.full_name as provider_name
  into v_appt
  from public.appointments a
  join public.patients pt on pt.id = a.patient_id
  join public.profiles pp on pp.id = pt.profile_id
  join public.services s on s.id = a.service_id
  join public.providers prov on prov.id = a.provider_id
  join public.profiles provp on provp.id = prov.profile_id
  where a.id = p_appointment_id
  for update of a;

  if not found then
    raise exception 'ERR_NOT_FOUND: appointment does not exist';
  end if;
  if v_appt.status not in ('booked', 'checked_in') then
    raise exception 'ERR_INVALID_STATUS: only booked or checked-in waiting appointments can receive proposals';
  end if;

  select id, status
  into v_queue
  from public.queue_tickets qt
  where qt.appointment_id = p_appointment_id
  for update;

  if found and v_queue.status = 'now_serving' then
    raise exception 'ERR_NOW_SERVING: appointment is already being served';
  end if;
  if v_appt.status = 'checked_in' and (not found or v_queue.status <> 'waiting') then
    raise exception 'ERR_INVALID_STATUS: checked-in appointment is no longer waiting';
  end if;

  if exists (
    select 1
    from public.appointment_reschedule_proposals arp
    where arp.appointment_id = p_appointment_id
      and arp.status = 'pending'
  ) then
    raise exception 'ERR_PENDING_EXISTS: this appointment already has a pending proposal';
  end if;

  select id, provider_id, service_id, slot_datetime, is_booked,
         held_by_reschedule_proposal_id, hold_expires_at
  into v_slot
  from public.time_slots
  where id = p_proposed_slot_id
  for update;

  if not found then
    raise exception 'ERR_NOT_FOUND: proposed slot does not exist';
  end if;
  if v_slot.is_booked then
    raise exception 'ERR_ALREADY_BOOKED: proposed slot is booked';
  end if;
  if v_slot.held_by_reschedule_proposal_id is not null and v_slot.hold_expires_at > now() then
    raise exception 'ERR_SLOT_HELD: proposed slot is held by another proposal';
  end if;
  if v_slot.service_id <> v_appt.service_id then
    raise exception 'ERR_SERVICE_MISMATCH: proposed slot is for a different service';
  end if;
  if v_slot.provider_id <> v_appt.provider_id then
    raise exception 'ERR_PROVIDER_MISMATCH: proposed slot is for a different provider';
  end if;
  if v_slot.slot_datetime <= now() then
    raise exception 'ERR_SLOT_PAST: proposed slot is in the past';
  end if;
  if public.is_exception_slot(v_slot.provider_id, v_slot.slot_datetime) then
    raise exception 'ERR_ON_EXCEPTION_DATE: proposed slot is on a leave or holiday date';
  end if;

  insert into public.appointment_reschedule_proposals (
    appointment_id, patient_id, provider_id, service_id, original_slot_id, proposed_slot_id,
    original_appointment_at, proposed_appointment_at, reason, token_hash,
    token_expires_at, response_code_hash, response_code_expires_at, created_by
  )
  values (
    p_appointment_id, v_appt.patient_id, v_appt.provider_id, v_appt.service_id,
    v_appt.slot_id, v_slot.id, v_appt.appointment_at, v_slot.slot_datetime,
    trim(p_reason), p_token_hash, p_token_expires_at, p_response_code_hash,
    p_response_code_expires_at, auth.uid()
  )
  returning id into v_proposal_id;

  update public.time_slots
  set held_by_reschedule_proposal_id = v_proposal_id,
      hold_expires_at = p_token_expires_at
  where id = v_slot.id;

  update public.queue_tickets qt
  set status = 'done'
  where qt.appointment_id = p_appointment_id
    and qt.status = 'waiting';

  insert into public.audit_log (actor_id, action, target_table, target_id)
  values (auth.uid(), 'emergency_reschedule_proposal_created', 'appointment_reschedule_proposals', v_proposal_id);

  if v_appt.status = 'checked_in' then
    insert into public.audit_log (actor_id, action, target_table, target_id)
    values (auth.uid(), 'provider_emergency_reschedule_after_checkin', 'appointment_reschedule_proposals', v_proposal_id);
  end if;

  return query select
    v_proposal_id,
    v_appt.id,
    v_appt.patient_id,
    v_appt.patient_phone,
    v_appt.patient_name,
    v_appt.service_name,
    v_appt.provider_name,
    v_appt.appointment_at,
    v_slot.slot_datetime,
    trim(p_reason),
    p_token_expires_at;
end;
$$;

grant execute on function public.admin_create_reschedule_proposal(uuid, uuid, text, text, timestamptz, text, timestamptz) to authenticated;

create or replace function public.respond_reschedule_proposal_by_id(
  p_proposal_id uuid,
  p_response text,
  p_require_code boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_proposal record;
  v_appt record;
  v_target record;
  v_queue_position int;
  v_ticket_number text;
  v_was_checked_in boolean;
begin
  if p_response not in ('accepted', 'declined') then
    raise exception 'ERR_INVALID_RESPONSE: response must be accepted or declined';
  end if;

  select arp.*, s.name as service_name, pp.phone as patient_phone
  into v_proposal
  from public.appointment_reschedule_proposals arp
  join public.services s on s.id = arp.service_id
  join public.patients pt on pt.id = arp.patient_id
  join public.profiles pp on pp.id = pt.profile_id
  where arp.id = p_proposal_id
  for update of arp;

  if not found then
    raise exception 'ERR_NOT_FOUND: reschedule request does not exist';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception 'ERR_ALREADY_ANSWERED: this reschedule request has already been answered';
  end if;
  if v_proposal.token_expires_at <= now()
     or (p_require_code and coalesce(v_proposal.response_code_expires_at, v_proposal.token_expires_at) <= now()) then
    update public.appointment_reschedule_proposals
    set status = 'expired',
        response_code_hash = null,
        updated_at = now()
    where id = v_proposal.id;

    update public.time_slots
    set held_by_reschedule_proposal_id = null,
        hold_expires_at = null
    where held_by_reschedule_proposal_id = v_proposal.id;

    raise exception 'ERR_EXPIRED: this reschedule request has expired';
  end if;

  select id, patient_id, provider_id, service_id, slot_id, status, appointment_at
  into v_appt
  from public.appointments
  where id = v_proposal.appointment_id
  for update;

  if not found then
    raise exception 'ERR_NOT_FOUND: appointment does not exist';
  end if;
  if v_appt.status not in ('booked', 'checked_in') then
    raise exception 'ERR_INVALID_STATUS: appointment can no longer be changed';
  end if;
  if exists (
    select 1
    from public.queue_tickets qt
    where qt.appointment_id = v_appt.id
      and qt.status = 'now_serving'
  ) then
    raise exception 'ERR_NOW_SERVING: appointment is already being served';
  end if;

  v_was_checked_in := v_appt.status = 'checked_in';

  select id, provider_id, service_id, slot_datetime, is_booked,
         held_by_reschedule_proposal_id, hold_expires_at
  into v_target
  from public.time_slots
  where id = v_proposal.proposed_slot_id
  for update;

  if not found then
    raise exception 'ERR_NOT_FOUND: proposed slot does not exist';
  end if;
  if v_target.held_by_reschedule_proposal_id is distinct from v_proposal.id then
    raise exception 'ERR_SLOT_NOT_RESERVED: proposed slot is no longer reserved for this request';
  end if;

  if p_response = 'accepted' then
    if v_target.is_booked then
      raise exception 'ERR_ALREADY_BOOKED: proposed slot is no longer available';
    end if;
    if v_target.provider_id <> v_proposal.provider_id or v_target.service_id <> v_proposal.service_id then
      raise exception 'ERR_SLOT_MISMATCH: proposed slot no longer matches this appointment';
    end if;

    update public.time_slots
    set is_booked = false,
        held_by_reschedule_proposal_id = null,
        hold_expires_at = null
    where id = v_appt.slot_id;

    update public.time_slots
    set is_booked = true,
        held_by_reschedule_proposal_id = null,
        hold_expires_at = null
    where id = v_target.id;

    update public.appointments
    set slot_id = v_target.id,
        provider_id = v_target.provider_id,
        appointment_at = v_target.slot_datetime,
        appointment_date = (v_target.slot_datetime at time zone 'Asia/Manila')::date,
        status = 'booked'
    where id = v_appt.id;

    select coalesce(max(qt.queue_position), 0) + 1 into v_queue_position
    from public.queue_tickets qt
    join public.appointments a on a.id = qt.appointment_id
    where a.provider_id = v_target.provider_id
      and qt.appointment_id <> v_appt.id
      and a.appointment_date = (v_target.slot_datetime at time zone 'Asia/Manila')::date;

    v_ticket_number := 'T' || lpad(v_queue_position::text, 3, '0');

    update public.queue_tickets
    set queue_position = v_queue_position,
        ticket_number = v_ticket_number,
        status = 'waiting'
    where appointment_id = v_appt.id;

    update public.appointment_reschedule_proposals
    set status = 'accepted',
        responded_at = now(),
        response_code_hash = null,
        response_code_locked_until = null,
        updated_at = now()
    where id = v_proposal.id;

    insert into public.audit_log (actor_id, action, target_table, target_id)
    values (null, 'emergency_reschedule_proposal_accepted', 'appointment_reschedule_proposals', v_proposal.id);

    if v_was_checked_in then
      insert into public.audit_log (actor_id, action, target_table, target_id)
      values (null, 'provider_emergency_reschedule_after_checkin_accepted', 'appointment_reschedule_proposals', v_proposal.id);
    end if;

    return jsonb_build_object(
      'proposal_id', v_proposal.id,
      'appointment_id', v_appt.id,
      'patient_id', v_proposal.patient_id,
      'patient_phone', v_proposal.patient_phone,
      'service_name', v_proposal.service_name,
      'proposed_appointment_at', v_target.slot_datetime,
      'status', 'accepted'
    );
  end if;

  update public.appointment_reschedule_proposals
  set status = 'declined',
      responded_at = now(),
      response_code_hash = null,
      response_code_locked_until = null,
      updated_at = now()
  where id = v_proposal.id;

  update public.time_slots
  set held_by_reschedule_proposal_id = null,
      hold_expires_at = null
  where id = v_target.id;

  update public.appointments
  set status = 'cancelled'
  where id = v_appt.id;

  update public.time_slots
  set is_booked = false
  where id = v_appt.slot_id;

  update public.queue_tickets
  set status = 'done'
  where appointment_id = v_appt.id
    and status in ('waiting', 'now_serving');

  insert into public.audit_log (actor_id, action, target_table, target_id)
  values (null, 'emergency_reschedule_declined', 'appointments', v_appt.id);

  if v_was_checked_in then
    insert into public.audit_log (actor_id, action, target_table, target_id)
    values (null, 'provider_emergency_reschedule_after_checkin_declined', 'appointments', v_appt.id);
  end if;

  return jsonb_build_object(
    'proposal_id', v_proposal.id,
    'appointment_id', v_appt.id,
    'patient_id', v_proposal.patient_id,
    'patient_phone', v_proposal.patient_phone,
    'service_name', v_proposal.service_name,
    'proposed_appointment_at', v_target.slot_datetime,
    'status', 'declined'
  );
end;
$$;

revoke all on function public.respond_reschedule_proposal_by_id(uuid, text, boolean) from public;
grant execute on function public.respond_reschedule_proposal_by_id(uuid, text, boolean) to service_role;
