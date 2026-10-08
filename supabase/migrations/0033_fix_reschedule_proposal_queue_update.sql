-- ============================================================
-- 0033_fix_reschedule_proposal_queue_update.sql
-- Qualify the queue_tickets update inside admin_create_reschedule_proposal.
-- The function returns a column named appointment_id, so unqualified
-- appointment_id in PL/pgSQL is ambiguous.
-- ============================================================

create or replace function public.admin_create_reschedule_proposal(
  p_appointment_id uuid,
  p_proposed_slot_id uuid,
  p_reason text,
  p_token_hash text,
  p_token_expires_at timestamptz
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
  v_proposal_id uuid;
begin
  if not public.is_admin() then
    raise exception 'ERR_FORBIDDEN: administrator access required';
  end if;

  perform public.release_expired_reschedule_proposals(200);

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'ERR_REASON_REQUIRED: reason is required';
  end if;

  if p_token_expires_at <= now() then
    raise exception 'ERR_INVALID_EXPIRY: token expiry must be in the future';
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
  if v_appt.status <> 'booked' then
    raise exception 'ERR_INVALID_STATUS: only booked appointments can receive proposals';
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
    token_expires_at, created_by
  )
  values (
    p_appointment_id, v_appt.patient_id, v_appt.provider_id, v_appt.service_id,
    v_appt.slot_id, v_slot.id, v_appt.appointment_at, v_slot.slot_datetime,
    trim(p_reason), p_token_hash, p_token_expires_at, auth.uid()
  )
  returning id into v_proposal_id;

  update public.time_slots
  set held_by_reschedule_proposal_id = v_proposal_id,
      hold_expires_at = p_token_expires_at
  where id = v_slot.id;

  update public.queue_tickets qt
  set status = 'done'
  where qt.appointment_id = p_appointment_id
    and qt.status in ('waiting', 'now_serving');

  insert into public.audit_log (actor_id, action, target_table, target_id)
  values (auth.uid(), 'emergency_reschedule_proposal_created', 'appointment_reschedule_proposals', v_proposal_id);

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

grant execute on function public.admin_create_reschedule_proposal(uuid, uuid, text, text, timestamptz) to authenticated;
