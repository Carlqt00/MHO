-- ============================================================
-- 0021_daily_service_capacity.sql
-- Fixed per-service daily booking capacity.
--
-- Capacity is stored on public.services and is never decremented. Capacity
-- remaining is calculated from non-cancelled appointments for the same
-- service_id + Manila appointment_date. Patient-visible remaining availability
-- is the lower of that service capacity remaining and currently open generated
-- time_slots.
--
-- Active capacity-consuming statuses in the current schema are every status
-- except 'cancelled': booked, checked_in, served, and no_show.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Store daily capacity on the existing services rows.
-- ------------------------------------------------------------
alter table public.services
  add column if not exists daily_capacity integer;

update public.services
set daily_capacity = case name
  when 'Dental' then 15
  when 'General Check-up' then 30
  when 'Immunization' then 20
  when 'Prenatal' then 30
  else daily_capacity
end
where name in ('Dental', 'General Check-up', 'Immunization', 'Prenatal');

-- Keep any non-standard existing services usable rather than making this
-- migration fail on a NULL. The fixed MHO services above are set explicitly.
update public.services
set daily_capacity = 30
where daily_capacity is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'services_daily_capacity_positive_chk'
      and conrelid = 'public.services'::regclass
  ) then
    alter table public.services
      add constraint services_daily_capacity_positive_chk
      check (daily_capacity > 0);
  end if;
end $$;

alter table public.services
  alter column daily_capacity set not null,
  alter column daily_capacity set default 30;

-- Helpful for capacity counts in both calendar and booking paths.
create index if not exists idx_appointments_service_date_active_capacity
  on public.appointments (service_id, appointment_date)
  where status <> 'cancelled';

-- ------------------------------------------------------------
-- 2. Calendar availability: keep the existing schedule/time-slot signals,
--    and add service-capacity fields for the selected service/date.
--    `remaining` / `remaining_slots` is the number that can actually still
--    be booked:
--      least(service capacity remaining, open upcoming generated time_slots)
--
-- Return rows only for days that still have at least one non-exception
-- generated slot, preserving the existing "no provider schedule" behavior.
-- ------------------------------------------------------------
drop function if exists public.service_daily_slot_status(uuid, date, date);

create function public.service_daily_slot_status(
  p_service_id uuid,
  p_from       date,
  p_to         date
)
returns table (
  day             date,
  remaining       int,
  unbooked        int,
  upcoming        int,
  total           int,
  daily_capacity  int,
  booked_count    int,
  remaining_slots int,
  is_full         boolean,
  open_slots      int
)
language sql
stable
security definer
set search_path = public
as $$
  with service_cap as (
    select s.daily_capacity
    from public.services s
    where s.id = p_service_id
  ),
  slot_counts as (
    select
      (ts.slot_datetime at time zone 'Asia/Manila')::date as day,
      count(*) filter (where not ts.is_booked and ts.slot_datetime >= now())::int as open_slots,
      count(*) filter (where not ts.is_booked)::int                               as unbooked,
      count(*) filter (where ts.slot_datetime >= now())::int                      as upcoming,
      count(*)::int                                                               as total
    from public.time_slots ts
    where ts.service_id = p_service_id
      and (ts.slot_datetime at time zone 'Asia/Manila')::date between p_from and p_to
      and not public.is_exception_slot(ts.provider_id, ts.slot_datetime)
    group by 1
  ),
  booking_counts as (
    select
      a.appointment_date as day,
      count(*)::int as booked_count
    from public.appointments a
    where a.service_id = p_service_id
      and a.appointment_date between p_from and p_to
      and a.status <> 'cancelled'
    group by a.appointment_date
  ),
  capacity_status as (
    select
      sc.day,
      cap.daily_capacity,
      coalesce(bc.booked_count, 0)::int as booked_count,
      greatest(cap.daily_capacity - coalesce(bc.booked_count, 0), 0)::int as capacity_remaining,
      sc.open_slots,
      sc.unbooked,
      sc.upcoming,
      sc.total
    from slot_counts sc
    cross join service_cap cap
    left join booking_counts bc on bc.day = sc.day
  )
  select
    cs.day,
    least(cs.capacity_remaining, cs.open_slots)::int as remaining,
    cs.unbooked,
    cs.upcoming,
    cs.total,
    cs.daily_capacity,
    cs.booked_count,
    least(cs.capacity_remaining, cs.open_slots)::int as remaining_slots,
    (cs.booked_count >= cs.daily_capacity) as is_full,
    cs.open_slots
  from capacity_status cs
  order by cs.day;
$$;

revoke all on function public.service_daily_slot_status(uuid, date, date) from public;
revoke execute on function public.service_daily_slot_status(uuid, date, date) from anon;
grant execute on function public.service_daily_slot_status(uuid, date, date) to authenticated;

-- ------------------------------------------------------------
-- 3. Booking enforcement: preserve existing guards and add a transaction-
--    scoped advisory lock per service/date before counting capacity.
--    This serializes concurrent bookings that compete for the same daily
--    service capacity, even when they select different time_slots.
-- ------------------------------------------------------------
create or replace function public.book_appointment(p_slot_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_patient_id       uuid;
  v_slot             record;
  v_appointment_id   uuid;
  v_queue_position   int;
  v_ticket_number    text;
  v_qr_code          text;
  v_appointment_date date;
  v_daily_capacity   int;
  v_booked_count     int;
begin
  -- Verify caller is a patient
  select id into v_patient_id
  from patients
  where profile_id = auth.uid();

  if v_patient_id is null then
    raise exception 'ERR_NOT_PATIENT: caller is not a patient account';
  end if;

  -- Lock the selected slot first, preserving the existing same-slot race guard.
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

  -- Preserve the provider leave / clinic holiday guard from 0009/0011.
  if public.is_exception_slot(v_slot.provider_id, v_slot.slot_datetime) then
    raise exception 'ERR_ON_EXCEPTION_DATE: slot is on a leave or holiday date';
  end if;

  v_appointment_date := (v_slot.slot_datetime at time zone 'Asia/Manila')::date;

  -- Serialize all bookings competing for the same service/date capacity.
  perform pg_advisory_xact_lock(
    hashtext(v_slot.service_id::text),
    hashtext(v_appointment_date::text)
  );

  select s.daily_capacity into v_daily_capacity
  from services s
  where s.id = v_slot.service_id;

  if v_daily_capacity is null then
    raise exception 'ERR_SERVICE_CAPACITY_MISSING: selected service has no daily capacity';
  end if;

  select count(*)::int into v_booked_count
  from appointments a
  where a.service_id = v_slot.service_id
    and a.appointment_date = v_appointment_date
    and a.status <> 'cancelled';

  if v_booked_count >= v_daily_capacity then
    raise exception 'ERR_SERVICE_FULL: No slots remaining for this service on the selected date.';
  end if;

  -- Mark slot booked
  update time_slots
  set is_booked = true
  where id = p_slot_id;

  -- Create appointment. appointment_at / appointment_date drive the
  -- per-patient booking guards from 0011.
  insert into appointments (
    patient_id, provider_id, service_id, slot_id, status,
    appointment_at, appointment_date
  )
  values (
    v_patient_id, v_slot.provider_id, v_slot.service_id, p_slot_id, 'booked',
    v_slot.slot_datetime,
    v_appointment_date
  )
  returning id into v_appointment_id;

  -- Queue position = tickets already issued for this provider on this
  -- same calendar day (Asia/Manila).
  select coalesce(max(qt.queue_position), 0) + 1 into v_queue_position
  from queue_tickets qt
  join appointments a on a.id = qt.appointment_id
  join time_slots ts on ts.id = a.slot_id
  where a.provider_id = v_slot.provider_id
    and (ts.slot_datetime at time zone 'Asia/Manila')::date = v_appointment_date;

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
