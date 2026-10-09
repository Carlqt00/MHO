-- ============================================================
-- 0034_reschedule_response_codes.sql
-- No-link SMS response codes for emergency reschedule proposals.
-- ============================================================

alter table public.appointment_reschedule_proposals
  add column if not exists response_code_hash text,
  add column if not exists response_code_expires_at timestamptz,
  add column if not exists response_code_attempts integer not null default 0,
  add column if not exists response_code_locked_until timestamptz;

create unique index if not exists uniq_reschedule_response_code_hash
  on public.appointment_reschedule_proposals (response_code_hash)
  where response_code_hash is not null;

create index if not exists idx_reschedule_response_code_status
  on public.appointment_reschedule_proposals (response_code_hash, status, response_code_expires_at)
  where response_code_hash is not null;

create table if not exists public.reschedule_response_code_rate_limits (
  attempt_key_hash text primary key,
  attempts integer not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.reschedule_response_code_rate_limits enable row level security;

revoke all on public.reschedule_response_code_rate_limits from public;
revoke all on public.reschedule_response_code_rate_limits from anon;
revoke all on public.reschedule_response_code_rate_limits from authenticated;

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

grant execute on function public.admin_create_reschedule_proposal(uuid, uuid, text, text, timestamptz, text, timestamptz) to authenticated;

create or replace function public.admin_rotate_reschedule_proposal_token(
  p_proposal_id uuid,
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
  v_row record;
begin
  if not public.is_admin() then
    raise exception 'ERR_FORBIDDEN: administrator access required';
  end if;

  perform public.release_expired_reschedule_proposals(200);

  if nullif(trim(coalesce(p_response_code_hash, '')), '') is null then
    raise exception 'ERR_RESPONSE_CODE_REQUIRED: response code hash is required';
  end if;

  select
    arp.id, arp.appointment_id, arp.patient_id, arp.proposed_slot_id, arp.status,
    pp.phone as patient_phone, pp.full_name as patient_name, s.name as service_name,
    provp.full_name as provider_name, arp.original_appointment_at,
    arp.proposed_appointment_at, arp.reason
  into v_row
  from public.appointment_reschedule_proposals arp
  join public.patients pt on pt.id = arp.patient_id
  join public.profiles pp on pp.id = pt.profile_id
  join public.services s on s.id = arp.service_id
  join public.providers prov on prov.id = arp.provider_id
  join public.profiles provp on provp.id = prov.profile_id
  where arp.id = p_proposal_id
  for update of arp;

  if not found then
    raise exception 'ERR_NOT_FOUND: proposal does not exist';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'ERR_INVALID_STATUS: only pending proposals can be resent';
  end if;
  if p_token_expires_at <= now() or p_response_code_expires_at <= now() then
    raise exception 'ERR_INVALID_EXPIRY: response expiry must be in the future';
  end if;

  update public.appointment_reschedule_proposals
  set token_hash = p_token_hash,
      token_expires_at = p_token_expires_at,
      response_code_hash = p_response_code_hash,
      response_code_expires_at = p_response_code_expires_at,
      response_code_attempts = 0,
      response_code_locked_until = null,
      updated_at = now()
  where id = p_proposal_id;

  update public.time_slots
  set hold_expires_at = p_token_expires_at
  where held_by_reschedule_proposal_id = p_proposal_id;

  insert into public.audit_log (actor_id, action, target_table, target_id)
  values (auth.uid(), 'emergency_reschedule_proposal_resent', 'appointment_reschedule_proposals', p_proposal_id);

  return query select
    v_row.id,
    v_row.appointment_id,
    v_row.patient_id,
    v_row.patient_phone,
    v_row.patient_name,
    v_row.service_name,
    v_row.provider_name,
    v_row.original_appointment_at,
    v_row.proposed_appointment_at,
    v_row.reason,
    p_token_expires_at;
end;
$$;

grant execute on function public.admin_rotate_reschedule_proposal_token(uuid, text, timestamptz, text, timestamptz) to authenticated;

create or replace function public.get_reschedule_proposal_by_code(
  p_response_code_hash text,
  p_attempt_key_hash text
)
returns table (
  proposal_id uuid,
  status text,
  effective_status text,
  service_name text,
  provider_name text,
  original_appointment_at timestamptz,
  proposed_appointment_at timestamptz,
  reason text,
  token_expires_at timestamptz,
  responded_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_limiter record;
  v_window interval := interval '15 minutes';
  v_max_attempts integer := 6;
  v_lock interval := interval '15 minutes';
begin
  if nullif(trim(coalesce(p_attempt_key_hash, '')), '') is null then
    raise exception 'ERR_RATE_LIMITED: too many attempts';
  end if;

  select *
  into v_limiter
  from public.reschedule_response_code_rate_limits
  where attempt_key_hash = p_attempt_key_hash
  for update;

  if found then
    if v_limiter.locked_until is not null and v_limiter.locked_until > now() then
      raise exception 'ERR_RATE_LIMITED: too many attempts';
    end if;
    if v_limiter.window_start <= now() - v_window then
      update public.reschedule_response_code_rate_limits
      set attempts = 0,
          window_start = now(),
          locked_until = null,
          updated_at = now()
      where attempt_key_hash = p_attempt_key_hash;
    end if;
  else
    insert into public.reschedule_response_code_rate_limits (attempt_key_hash)
    values (p_attempt_key_hash);
  end if;

  if exists (
    select 1
    from public.appointment_reschedule_proposals arp
    where arp.response_code_hash = p_response_code_hash
  ) then
    update public.reschedule_response_code_rate_limits
    set attempts = 0,
        locked_until = null,
        updated_at = now()
    where attempt_key_hash = p_attempt_key_hash;

    return query
      select
        arp.id,
        arp.status,
        case
          when arp.status = 'pending'
            and coalesce(arp.response_code_expires_at, arp.token_expires_at) <= now()
          then 'expired'
          else arp.status
        end as effective_status,
        s.name,
        provp.full_name,
        arp.original_appointment_at,
        arp.proposed_appointment_at,
        arp.reason,
        arp.token_expires_at,
        arp.responded_at
      from public.appointment_reschedule_proposals arp
      join public.services s on s.id = arp.service_id
      join public.providers prov on prov.id = arp.provider_id
      join public.profiles provp on provp.id = prov.profile_id
      where arp.response_code_hash = p_response_code_hash
        and arp.response_code_hash is not null
      limit 1;

    return;
  end if;

  update public.reschedule_response_code_rate_limits
  set attempts = case
        when window_start <= now() - v_window then 1
        else attempts + 1
      end,
      window_start = case
        when window_start <= now() - v_window then now()
        else window_start
      end,
      locked_until = case
        when (
          case when window_start <= now() - v_window then 1 else attempts + 1 end
        ) >= v_max_attempts then now() + v_lock
        else null
      end,
      updated_at = now()
  where attempt_key_hash = p_attempt_key_hash;

  return;
end;
$$;

grant execute on function public.get_reschedule_proposal_by_code(text, text) to anon, authenticated;

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
  if v_appt.status <> 'booked' then
    raise exception 'ERR_INVALID_STATUS: appointment can no longer be changed';
  end if;

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
        appointment_date = (v_target.slot_datetime at time zone 'Asia/Manila')::date
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

create or replace function public.respond_reschedule_proposal(
  p_token_hash text,
  p_response text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_proposal_id uuid;
begin
  select id
  into v_proposal_id
  from public.appointment_reschedule_proposals
  where token_hash = p_token_hash
  limit 1;

  if v_proposal_id is null then
    raise exception 'ERR_NOT_FOUND: reschedule request does not exist';
  end if;

  return public.respond_reschedule_proposal_by_id(v_proposal_id, p_response, false);
end;
$$;

grant execute on function public.respond_reschedule_proposal(text, text) to anon, authenticated;

create or replace function public.respond_reschedule_proposal_by_code(
  p_response_code_hash text,
  p_response text,
  p_attempt_key_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_proposal_id uuid;
  v_limiter record;
  v_window interval := interval '15 minutes';
  v_max_attempts integer := 6;
  v_lock interval := interval '15 minutes';
begin
  if nullif(trim(coalesce(p_attempt_key_hash, '')), '') is null then
    raise exception 'ERR_RATE_LIMITED: too many attempts';
  end if;

  select *
  into v_limiter
  from public.reschedule_response_code_rate_limits
  where attempt_key_hash = p_attempt_key_hash
  for update;

  if found then
    if v_limiter.locked_until is not null and v_limiter.locked_until > now() then
      raise exception 'ERR_RATE_LIMITED: too many attempts';
    end if;
    if v_limiter.window_start <= now() - v_window then
      update public.reschedule_response_code_rate_limits
      set attempts = 0,
          window_start = now(),
          locked_until = null,
          updated_at = now()
      where attempt_key_hash = p_attempt_key_hash;
    end if;
  else
    insert into public.reschedule_response_code_rate_limits (attempt_key_hash)
    values (p_attempt_key_hash);
  end if;

  select id
  into v_proposal_id
  from public.appointment_reschedule_proposals
  where response_code_hash = p_response_code_hash
  limit 1;

  if v_proposal_id is null then
    update public.reschedule_response_code_rate_limits
    set attempts = case
          when window_start <= now() - v_window then 1
          else attempts + 1
        end,
        window_start = case
          when window_start <= now() - v_window then now()
          else window_start
        end,
        locked_until = case
          when (
            case when window_start <= now() - v_window then 1 else attempts + 1 end
          ) >= v_max_attempts then now() + v_lock
          else null
        end,
        updated_at = now()
    where attempt_key_hash = p_attempt_key_hash;

    raise exception 'ERR_NOT_FOUND: reschedule request does not exist';
  end if;

  update public.reschedule_response_code_rate_limits
  set attempts = 0,
      locked_until = null,
      updated_at = now()
  where attempt_key_hash = p_attempt_key_hash;

  update public.appointment_reschedule_proposals
  set response_code_attempts = response_code_attempts + 1,
      updated_at = now()
  where id = v_proposal_id;

  return public.respond_reschedule_proposal_by_id(v_proposal_id, p_response, true);
end;
$$;

grant execute on function public.respond_reschedule_proposal_by_code(text, text, text) to anon, authenticated;
