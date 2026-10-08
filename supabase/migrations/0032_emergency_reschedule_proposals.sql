-- ============================================================
-- 0032_emergency_reschedule_proposals.sql
-- Emergency / provider-unavailable reschedule proposal workflow.
-- ============================================================

create table if not exists public.appointment_reschedule_proposals (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  patient_id uuid not null references public.patients (id) on delete cascade,
  provider_id uuid not null references public.providers (id) on delete cascade,
  service_id uuid not null references public.services (id),
  original_slot_id uuid not null references public.time_slots (id),
  proposed_slot_id uuid not null references public.time_slots (id),
  original_appointment_at timestamptz not null,
  proposed_appointment_at timestamptz not null,
  reason text not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  token_hash text not null unique,
  token_expires_at timestamptz not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists uniq_pending_reschedule_proposal_per_appointment
  on public.appointment_reschedule_proposals (appointment_id)
  where status = 'pending';

create unique index if not exists uniq_pending_reschedule_proposal_per_slot
  on public.appointment_reschedule_proposals (proposed_slot_id)
  where status = 'pending';

create index if not exists idx_reschedule_proposals_appointment
  on public.appointment_reschedule_proposals (appointment_id);

create index if not exists idx_reschedule_proposals_patient
  on public.appointment_reschedule_proposals (patient_id);

create index if not exists idx_reschedule_proposals_status
  on public.appointment_reschedule_proposals (status, token_expires_at);

alter table public.time_slots
  add column if not exists held_by_reschedule_proposal_id uuid
    references public.appointment_reschedule_proposals (id) on delete set null,
  add column if not exists hold_expires_at timestamptz;

create index if not exists idx_time_slots_reschedule_hold
  on public.time_slots (held_by_reschedule_proposal_id, hold_expires_at)
  where held_by_reschedule_proposal_id is not null;

alter table public.appointment_reschedule_proposals enable row level security;

drop policy if exists "admin: select reschedule proposals" on public.appointment_reschedule_proposals;
create policy "admin: select reschedule proposals"
  on public.appointment_reschedule_proposals for select to authenticated
  using (public.is_admin());

drop policy if exists "patient: select own reschedule proposals" on public.appointment_reschedule_proposals;
create policy "patient: select own reschedule proposals"
  on public.appointment_reschedule_proposals for select to authenticated
  using (patient_id = public.my_patient_id());

grant select on public.appointment_reschedule_proposals to authenticated;

-- Open-slot reads must hide active emergency proposal holds. Expired holds are
-- visible again even before the cleanup function records them as expired.
create or replace view public.open_slots
with (security_invoker = true)
as
  select ts.*
  from public.time_slots ts
  where not ts.is_booked
    and not public.is_exception_slot(ts.provider_id, ts.slot_datetime)
    and (
      ts.held_by_reschedule_proposal_id is null
      or ts.hold_expires_at <= now()
    );

grant select on public.open_slots to authenticated;

create or replace function public.release_expired_reschedule_proposals(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_count integer := 0;
begin
  with expired as (
    select id
    from public.appointment_reschedule_proposals
    where status = 'pending'
      and token_expires_at <= now()
    order by token_expires_at
    limit greatest(coalesce(p_limit, 200), 1)
    for update skip locked
  ),
  updated as (
    update public.appointment_reschedule_proposals arp
    set status = 'expired',
        updated_at = now()
    from expired e
    where arp.id = e.id
    returning arp.id
  ),
  released as (
    update public.time_slots ts
    set held_by_reschedule_proposal_id = null,
        hold_expires_at = null
    from updated u
    where ts.held_by_reschedule_proposal_id = u.id
    returning ts.id
  )
  select count(*) into v_count from updated;

  return v_count;
end;
$$;

grant execute on function public.release_expired_reschedule_proposals(integer) to authenticated;
grant execute on function public.release_expired_reschedule_proposals(integer) to service_role;

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

create or replace function public.admin_rotate_reschedule_proposal_token(
  p_proposal_id uuid,
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
  v_row record;
begin
  if not public.is_admin() then
    raise exception 'ERR_FORBIDDEN: administrator access required';
  end if;

  perform public.release_expired_reschedule_proposals(200);

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
  if p_token_expires_at <= now() then
    raise exception 'ERR_INVALID_EXPIRY: token expiry must be in the future';
  end if;

  update public.appointment_reschedule_proposals
  set token_hash = p_token_hash,
      token_expires_at = p_token_expires_at,
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

grant execute on function public.admin_rotate_reschedule_proposal_token(uuid, text, timestamptz) to authenticated;

create or replace function public.get_reschedule_proposal_by_token(p_token_hash text)
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
set search_path = public
as $$
begin
  return query
    select
      arp.id,
      arp.status,
      case
        when arp.status = 'pending' and arp.token_expires_at <= now() then 'expired'
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
    where arp.token_hash = p_token_hash
    limit 1;
end;
$$;

grant execute on function public.get_reschedule_proposal_by_token(text) to anon, authenticated;

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
  where arp.token_hash = p_token_hash
  for update of arp;

  if not found then
    raise exception 'ERR_NOT_FOUND: reschedule request does not exist';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception 'ERR_ALREADY_ANSWERED: this reschedule request has already been answered';
  end if;
  if v_proposal.token_expires_at <= now() then
    update public.appointment_reschedule_proposals
    set status = 'expired',
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

grant execute on function public.respond_reschedule_proposal(text, text) to anon, authenticated;

-- Existing booking/rescheduling guards now also reject active proposal holds.
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
  perform public.release_expired_reschedule_proposals(200);

  select id into v_patient_id
  from patients
  where profile_id = auth.uid();

  if v_patient_id is null then
    raise exception 'ERR_NOT_PATIENT: caller is not a patient account';
  end if;

  select ts.id, ts.provider_id, ts.service_id, ts.slot_datetime, ts.is_booked,
         ts.held_by_reschedule_proposal_id, ts.hold_expires_at
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
  if v_slot.held_by_reschedule_proposal_id is not null and v_slot.hold_expires_at > now() then
    raise exception 'ERR_SLOT_HELD: this slot is held for a reschedule response';
  end if;
  if public.is_exception_slot(v_slot.provider_id, v_slot.slot_datetime) then
    raise exception 'ERR_ON_EXCEPTION_DATE: slot is on a leave or holiday date';
  end if;

  update time_slots
  set is_booked = true
  where id = p_slot_id;

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
  perform public.release_expired_reschedule_proposals(200);

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

  if exists (
    select 1
    from public.appointment_reschedule_proposals arp
    where arp.appointment_id = p_appointment_id
      and arp.status = 'pending'
      and arp.token_expires_at > now()
  ) then
    raise exception 'ERR_PENDING_PROPOSAL: appointment is awaiting reschedule confirmation';
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

  select ts.id, ts.provider_id, ts.service_id, ts.slot_datetime, ts.is_booked,
         ts.held_by_reschedule_proposal_id, ts.hold_expires_at
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
  if v_slot.held_by_reschedule_proposal_id is not null and v_slot.hold_expires_at > now() then
    raise exception 'ERR_SLOT_HELD: this slot is held for a reschedule response';
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

  update time_slots set is_booked = false where id = v_appt.slot_id;
  update time_slots set is_booked = true  where id = p_new_slot_id;

  update appointments
  set slot_id          = p_new_slot_id,
      provider_id      = v_slot.provider_id,
      appointment_at   = v_slot.slot_datetime,
      appointment_date = (v_slot.slot_datetime at time zone 'Asia/Manila')::date
  where id = p_appointment_id;

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

create or replace function public.set_appointment_status(
  p_appointment_id uuid,
  p_status         text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role text;
  v_appt record;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role not in ('nurse', 'staff', 'admin') then
    raise exception 'ERR_FORBIDDEN: only clinic personnel can update appointment status';
  end if;

  if p_status not in ('checked_in', 'no_show') then
    raise exception 'ERR_INVALID_STATUS: unsupported target status %', p_status;
  end if;

  select id, slot_id, status, appointment_at
  into v_appt
  from appointments
  where id = p_appointment_id
  for update;

  if not found then
    raise exception 'ERR_NOT_FOUND: appointment does not exist';
  end if;

  if exists (
    select 1
    from public.appointment_reschedule_proposals arp
    where arp.appointment_id = p_appointment_id
      and arp.status = 'pending'
      and arp.token_expires_at > now()
  ) then
    raise exception 'ERR_PENDING_PROPOSAL: appointment is awaiting reschedule confirmation';
  end if;

  if p_status = 'checked_in' and v_appt.status <> 'booked' then
    raise exception 'ERR_INVALID_STATUS: cannot check in a % appointment', v_appt.status;
  end if;
  if p_status = 'no_show' and v_appt.status not in ('booked', 'checked_in') then
    raise exception 'ERR_INVALID_STATUS: cannot mark a % appointment as no-show', v_appt.status;
  end if;

  if p_status = 'checked_in'
     and v_appt.status = 'booked'
     and v_appt.appointment_at + interval '15 minutes' <= now() then
    update appointments
    set status = 'cancelled'
    where id = p_appointment_id
      and status = 'booked'
      and appointment_at + interval '15 minutes' <= now();

    update time_slots set is_booked = false where id = v_appt.slot_id;

    update queue_tickets
    set status = 'done'
    where appointment_id = p_appointment_id
      and status in ('waiting', 'now_serving');

    insert into audit_log (actor_id, action, target_table, target_id)
    values (auth.uid(), 'auto_cancel_missed_checkin', 'appointments', p_appointment_id);

    return jsonb_build_object(
      'appointment_id', p_appointment_id,
      'appointment_status', 'cancelled',
      'reason', 'missed_checkin_deadline'
    );
  end if;

  update appointments set status = p_status where id = p_appointment_id;

  if p_status = 'no_show' then
    update queue_tickets
    set status = 'done'
    where appointment_id = p_appointment_id
      and status in ('waiting', 'now_serving');
  end if;

  insert into audit_log (actor_id, action, target_table, target_id)
  values (auth.uid(), 'set_appointment_status:' || p_status, 'appointments', p_appointment_id);

  return jsonb_build_object(
    'appointment_id', p_appointment_id,
    'appointment_status', p_status
  );
end;
$$;

grant execute on function public.set_appointment_status(uuid, text) to authenticated;

create or replace function public.auto_cancel_missed_appointments(p_limit integer default 100)
returns table (appointment_id uuid)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_started_at timestamptz;
begin
  select value::timestamptz into v_started_at
  from public.system_settings
  where key = 'auto_cancel_missed_checkins_started_at';

  if v_started_at is null then
    v_started_at := now();
  end if;

  return query
  with eligible as (
    select a.id, a.slot_id
    from public.appointments a
    where a.status = 'booked'
      and a.appointment_at >= v_started_at - interval '15 minutes'
      and a.appointment_at + interval '15 minutes' <= now()
      and not exists (
        select 1
        from public.appointment_reschedule_proposals arp
        where arp.appointment_id = a.id
          and arp.status = 'pending'
          and arp.token_expires_at > now()
      )
      and not exists (
        select 1
        from public.queue_tickets qt
        where qt.appointment_id = a.id
          and qt.status = 'now_serving'
      )
    order by a.appointment_at
    limit greatest(coalesce(p_limit, 100), 1)
    for update of a skip locked
  ),
  cancelled as (
    update public.appointments a
    set status = 'cancelled'
    from eligible e
    where a.id = e.id
      and a.status = 'booked'
      and a.appointment_at >= v_started_at - interval '15 minutes'
      and a.appointment_at + interval '15 minutes' <= now()
    returning a.id, a.slot_id
  ),
  released_slots as (
    update public.time_slots ts
    set is_booked = false
    from cancelled c
    where ts.id = c.slot_id
    returning ts.id
  ),
  closed_tickets as (
    update public.queue_tickets qt
    set status = 'done'
    from cancelled c
    where qt.appointment_id = c.id
      and qt.status = 'waiting'
    returning qt.id
  ),
  audit as (
    insert into public.audit_log (actor_id, action, target_table, target_id)
    select null, 'auto_cancel_missed_checkin', 'appointments', c.id
    from cancelled c
    returning target_id
  )
  select c.id
  from cancelled c;
end;
$$;

revoke all on function public.auto_cancel_missed_appointments(integer) from public;
grant execute on function public.auto_cancel_missed_appointments(integer) to service_role;
