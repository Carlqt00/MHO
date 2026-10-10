-- ============================================================
-- 0037_patient_appointment_overlap_guard.sql
-- Prevent overlapping active appointments for the same patient.
--
-- Active overlap statuses: booked, checked_in.
-- Non-blocking statuses: cancelled, served, completed/no_show equivalents
-- in the current schema (served, no_show).
-- ============================================================

set search_path = public, extensions;

create extension if not exists btree_gist with schema extensions;

alter table public.time_slots
  add column if not exists duration_minutes integer;

alter table public.appointments
  add column if not exists appointment_duration_minutes integer,
  add column if not exists appointment_time_range tstzrange;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'time_slots_duration_minutes_positive_chk'
      and conrelid = 'public.time_slots'::regclass
  ) then
    alter table public.time_slots
      add constraint time_slots_duration_minutes_positive_chk
      check (duration_minutes > 0 and duration_minutes <= 480);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'appointments_duration_minutes_positive_chk'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_duration_minutes_positive_chk
      check (appointment_duration_minutes > 0 and appointment_duration_minutes <= 480);
  end if;
end $$;

create or replace function public.infer_slot_duration_minutes(p_slot_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select id, provider_id, service_id, slot_datetime
    from public.time_slots
    where id = p_slot_id
  ),
  adjacent as (
    select abs(extract(epoch from (ts.slot_datetime - target.slot_datetime)) / 60)::int as minutes
    from target
    join public.time_slots ts
      on ts.provider_id = target.provider_id
     and ts.service_id = target.service_id
     and ts.id <> target.id
     and (ts.slot_datetime at time zone 'Asia/Manila')::date =
         (target.slot_datetime at time zone 'Asia/Manila')::date
    where abs(extract(epoch from (ts.slot_datetime - target.slot_datetime)) / 60)::int between 5 and 480
    order by abs(extract(epoch from (ts.slot_datetime - target.slot_datetime)) / 60)
    limit 1
  )
  select coalesce((select minutes from adjacent), 30);
$$;

update public.time_slots ts
set duration_minutes = public.infer_slot_duration_minutes(ts.id)
where ts.duration_minutes is null;

alter table public.time_slots
  alter column duration_minutes set default 30,
  alter column duration_minutes set not null;

update public.appointments a
set appointment_duration_minutes = coalesce(ts.duration_minutes, public.infer_slot_duration_minutes(ts.id), 30)
from public.time_slots ts
where ts.id = a.slot_id
  and a.appointment_duration_minutes is null;

update public.appointments
set appointment_time_range = tstzrange(
  appointment_at,
  appointment_at + (appointment_duration_minutes * interval '1 minute'),
  '[)'
)
where appointment_time_range is null
  or lower(appointment_time_range) is distinct from appointment_at
  or upper(appointment_time_range) is distinct from appointment_at + (appointment_duration_minutes * interval '1 minute');

alter table public.appointments
  alter column appointment_duration_minutes set default 30,
  alter column appointment_duration_minutes set not null,
  alter column appointment_time_range set not null;

create or replace function public.sync_appointment_slot_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot record;
begin
  select slot_datetime, duration_minutes
  into v_slot
  from public.time_slots
  where id = new.slot_id;

  if not found then
    raise exception 'ERR_NOT_FOUND: appointment slot does not exist';
  end if;

  new.appointment_at := v_slot.slot_datetime;
  new.appointment_date := (v_slot.slot_datetime at time zone 'Asia/Manila')::date;
  new.appointment_duration_minutes := coalesce(v_slot.duration_minutes, 30);
  new.appointment_time_range := tstzrange(
    new.appointment_at,
    new.appointment_at + (new.appointment_duration_minutes * interval '1 minute'),
    '[)'
  );
  return new;
end;
$$;

drop trigger if exists trg_sync_appointment_slot_fields on public.appointments;
create trigger trg_sync_appointment_slot_fields
  before insert or update of slot_id, appointment_at, appointment_duration_minutes on public.appointments
  for each row execute function public.sync_appointment_slot_fields();

drop index if exists public.uniq_active_service_per_patient_day;
create unique index uniq_active_service_per_patient_day
  on public.appointments (patient_id, service_id, appointment_date)
  where status in ('booked', 'checked_in');

drop index if exists public.uniq_active_time_per_patient;
create unique index uniq_active_time_per_patient
  on public.appointments (patient_id, appointment_at)
  where status in ('booked', 'checked_in');

drop index if exists public.idx_appointments_patient_active_overlap;
create index idx_appointments_patient_active_overlap
  on public.appointments (patient_id, appointment_at)
  where status in ('booked', 'checked_in');

alter table public.appointments
  drop constraint if exists no_patient_active_appointment_overlap;

alter table public.appointments
  add constraint no_patient_active_appointment_overlap
  exclude using gist (
    patient_id with =,
    appointment_time_range with &&
  )
  where (status in ('booked', 'checked_in'));

create or replace function public.patient_has_overlapping_active_appointment(
  p_patient_id uuid,
  p_start timestamptz,
  p_duration_minutes integer,
  p_exclude_appointment_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.appointments a
    where a.patient_id = p_patient_id
      and a.status in ('booked', 'checked_in')
      and (p_exclude_appointment_id is null or a.id <> p_exclude_appointment_id)
      and tstzrange(p_start, p_start + (p_duration_minutes * interval '1 minute'), '[)')
        && a.appointment_time_range
  );
$$;

create or replace function public.generate_time_slots(
  p_provider_id      uuid,
  p_service_id       uuid,
  p_from             date,
  p_to               date,
  p_interval_minutes int  default 30,
  p_dry_run          boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date        date;
  v_dow         int;
  v_win         record;
  v_slot_time   time;
  v_step        interval := make_interval(mins => p_interval_minutes);
  v_slot_ts     timestamptz;
  v_to_create   int := 0;
  v_existing    int := 0;
  v_exc_days    int := 0;
  v_avail_days  int := 0;
  v_had_window  boolean;
  v_sample      jsonb := '[]'::jsonb;
  v_desired     timestamptz[] := array[]::timestamptz[];
  v_stale       int := 0;
  v_range_start timestamptz;
  v_range_end   timestamptz;
begin
  if not public.is_admin() then
    raise exception 'ERR_FORBIDDEN: only an administrator can generate slots';
  end if;

  if p_interval_minutes is null or p_interval_minutes < 5 or p_interval_minutes > 480 then
    raise exception 'ERR_INVALID_INTERVAL: interval must be between 5 and 480 minutes';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'ERR_INVALID_RANGE: from-date must be on or before to-date';
  end if;
  if (p_to - p_from) > 180 then
    raise exception 'ERR_RANGE_TOO_LARGE: date range cannot exceed 180 days';
  end if;
  if not exists (select 1 from providers where id = p_provider_id) then
    raise exception 'ERR_NOT_FOUND: provider does not exist';
  end if;
  if not exists (select 1 from services where id = p_service_id) then
    raise exception 'ERR_NOT_FOUND: service does not exist';
  end if;

  v_range_start := (p_from::text || ' 00:00:00+08')::timestamptz;
  v_range_end := ((p_to + 1)::text || ' 00:00:00+08')::timestamptz;

  for v_date in
    select gs::date from generate_series(p_from, p_to, '1 day'::interval) gs
  loop
    v_dow := extract(dow from v_date);

    if exists (
      select 1 from provider_time_off t
      where t.exception_date = v_date
        and (t.provider_id = p_provider_id or t.provider_id is null)
    ) then
      v_exc_days := v_exc_days + 1;
      continue;
    end if;

    v_had_window := false;

    for v_win in
      select start_time, end_time
      from provider_availability
      where provider_id = p_provider_id and day_of_week = v_dow
      order by start_time
    loop
      v_had_window := true;
      v_slot_time := v_win.start_time;

      while v_slot_time + v_step <= v_win.end_time loop
        v_slot_ts := (v_date::text || ' ' || v_slot_time::text || '+08')::timestamptz;
        v_desired := array_append(v_desired, v_slot_ts);

        if jsonb_array_length(v_sample) < 8 then
          v_sample := v_sample || to_jsonb(v_slot_ts);
        end if;

        v_slot_time := v_slot_time + v_step;
      end loop;
    end loop;

    if v_had_window then
      v_avail_days := v_avail_days + 1;
    end if;
  end loop;

  select count(*)::int
  into v_existing
  from unnest(v_desired) desired(slot_datetime)
  where exists (
    select 1
    from time_slots ts
    where ts.provider_id = p_provider_id
      and ts.slot_datetime = desired.slot_datetime
  );

  select count(*)::int
  into v_to_create
  from unnest(v_desired) desired(slot_datetime)
  where not exists (
    select 1
    from time_slots ts
    where ts.provider_id = p_provider_id
      and ts.slot_datetime = desired.slot_datetime
  );

  select count(*)::int
  into v_stale
  from time_slots ts
  where ts.provider_id = p_provider_id
    and ts.service_id = p_service_id
    and ts.slot_datetime >= greatest(v_range_start, now())
    and ts.slot_datetime < v_range_end
    and not ts.is_booked
    and not exists (
      select 1 from appointments a where a.slot_id = ts.id
    )
    and not (ts.slot_datetime = any(v_desired));

  if not p_dry_run then
    delete from time_slots ts
    where ts.provider_id = p_provider_id
      and ts.service_id = p_service_id
      and ts.slot_datetime >= greatest(v_range_start, now())
      and ts.slot_datetime < v_range_end
      and not ts.is_booked
      and not exists (
        select 1 from appointments a where a.slot_id = ts.id
      )
      and not (ts.slot_datetime = any(v_desired));

    insert into time_slots (provider_id, service_id, slot_datetime, duration_minutes)
    select p_provider_id, p_service_id, desired.slot_datetime, p_interval_minutes
    from unnest(v_desired) desired(slot_datetime)
    where not exists (
      select 1
      from time_slots ts
      where ts.provider_id = p_provider_id
        and ts.slot_datetime = desired.slot_datetime
    )
    on conflict (provider_id, slot_datetime) do nothing;
  end if;

  if not p_dry_run and (v_to_create > 0 or v_stale > 0) then
    insert into audit_log (actor_id, action, target_table, target_id)
    values (auth.uid(), 'generate_time_slots', 'time_slots', p_provider_id);
  end if;

  return jsonb_build_object(
    'dry_run',                p_dry_run,
    'to_create',             v_to_create,
    'already_exist',         v_existing,
    'stale_unbooked_removed', v_stale,
    'exception_days',        v_exc_days,
    'days_with_availability', v_avail_days,
    'interval_minutes',      p_interval_minutes,
    'sample',                v_sample
  );
end;
$$;

grant execute on function
  public.generate_time_slots(uuid, uuid, date, date, int, boolean)
  to authenticated;

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
  select id into v_patient_id
  from patients
  where profile_id = auth.uid();

  if v_patient_id is null then
    raise exception 'ERR_NOT_PATIENT: caller is not a patient account';
  end if;

  select ts.id, ts.provider_id, ts.service_id, ts.slot_datetime, ts.is_booked, ts.duration_minutes
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

  if public.is_exception_slot(v_slot.provider_id, v_slot.slot_datetime) then
    raise exception 'ERR_ON_EXCEPTION_DATE: slot is on a leave or holiday date';
  end if;

  if public.patient_has_overlapping_active_appointment(
    v_patient_id,
    v_slot.slot_datetime,
    v_slot.duration_minutes
  ) then
    raise exception 'ERR_PATIENT_OVERLAP: overlapping active appointment exists';
  end if;

  v_appointment_date := (v_slot.slot_datetime at time zone 'Asia/Manila')::date;

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

  update time_slots
  set is_booked = true
  where id = p_slot_id;

  insert into appointments (
    patient_id, provider_id, service_id, slot_id, status,
    appointment_at, appointment_date, appointment_duration_minutes
  )
  values (
    v_patient_id, v_slot.provider_id, v_slot.service_id, p_slot_id, 'booked',
    v_slot.slot_datetime,
    v_appointment_date,
    v_slot.duration_minutes
  )
  returning id into v_appointment_id;

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
         ts.held_by_reschedule_proposal_id, ts.hold_expires_at, ts.duration_minutes
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

  if public.patient_has_overlapping_active_appointment(
    v_appt.patient_id,
    v_slot.slot_datetime,
    v_slot.duration_minutes,
    p_appointment_id
  ) then
    raise exception 'ERR_PATIENT_OVERLAP: overlapping active appointment exists';
  end if;

  v_old_slot_at := v_appt.old_slot_at;

  update time_slots set is_booked = false where id = v_appt.slot_id;
  update time_slots set is_booked = true  where id = p_new_slot_id;

  update appointments
  set slot_id          = p_new_slot_id,
      provider_id      = v_slot.provider_id,
      appointment_at   = v_slot.slot_datetime,
      appointment_date = (v_slot.slot_datetime at time zone 'Asia/Manila')::date,
      appointment_duration_minutes = v_slot.duration_minutes
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
