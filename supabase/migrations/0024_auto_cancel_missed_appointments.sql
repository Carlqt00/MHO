-- ============================================================
-- 0024_auto_cancel_missed_appointments.sql
-- Server-side missed check-in auto-cancellation.
--
-- Rule: a booked appointment that is still not checked in at
-- appointment_at + 15 minutes is cancelled. The current appointment_at
-- column is updated by reschedule_appointment, so changed times get a fresh
-- deadline automatically.
-- ============================================================

-- Small persistent setting used as a rollout guard. The job ignores
-- appointments scheduled before this migration was applied minus the grace
-- period, so old/test booked rows do not trigger an unexpected SMS batch.
create table if not exists public.system_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into public.system_settings (key, value)
values ('auto_cancel_missed_checkins_started_at', now()::text)
on conflict (key) do nothing;

revoke all on public.system_settings from anon;
revoke all on public.system_settings from authenticated;

create index if not exists idx_appointments_auto_cancel_missed
  on public.appointments (appointment_at)
  where status = 'booked';

create unique index if not exists uniq_auto_cancel_missed_sms_once
  on public.notification_logs (appointment_id, event)
  where appointment_id is not null
    and event = 'appointment_auto_cancelled_missed_checkin';

-- ------------------------------------------------------------
-- cancel_appointment: preserve normal cancellation behavior, but lock the
-- appointment row while deciding so manual cancel/check-in/automation do not
-- race through stale status reads.
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
  where a.id = p_appointment_id
  for update of a;

  if not found then
    raise exception 'ERR_NOT_FOUND: appointment does not exist';
  end if;

  if v_role = 'patient' and v_appt.profile_id <> auth.uid() then
    raise exception 'ERR_FORBIDDEN: cannot cancel another patient''s appointment';
  end if;
  if v_role not in ('patient', 'staff', 'admin') then
    raise exception 'ERR_FORBIDDEN: only the patient or clinic staff can cancel';
  end if;

  if v_appt.status not in ('booked', 'checked_in') then
    raise exception 'ERR_INVALID_STATUS: cannot cancel a % appointment', v_appt.status;
  end if;

  update appointments set status = 'cancelled' where id = p_appointment_id;
  update time_slots set is_booked = false where id = v_appt.slot_id;

  update queue_tickets
  set status = 'done'
  where appointment_id = p_appointment_id
    and status in ('waiting', 'now_serving');

  insert into audit_log (actor_id, action, target_table, target_id)
  values (auth.uid(), 'cancel_appointment', 'appointments', p_appointment_id);
end;
$$;

grant execute on function public.cancel_appointment(uuid) to authenticated;

-- ------------------------------------------------------------
-- set_appointment_status: staff check-in/no-show, now with the same server
-- deadline guard. A late check-in atomically cancels the appointment and
-- returns a structured "cancelled" result so callers do not send check-in SMS.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- auto_cancel_missed_appointments: intended for a scheduled service-role Edge
-- Function. The final UPDATE repeats every eligibility condition after row
-- locking, so a just-in-time check-in wins cleanly.
-- ------------------------------------------------------------
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

create or replace function public.list_auto_cancel_missed_sms_due(p_limit integer default 100)
returns table (appointment_id uuid)
language sql
security definer
set search_path = public
as $$
  select distinct al.target_id as appointment_id
  from public.audit_log al
  join public.appointments a on a.id = al.target_id
  where al.action = 'auto_cancel_missed_checkin'
    and al.target_table = 'appointments'
    and a.status = 'cancelled'
    and not exists (
      select 1
      from public.notification_logs nl
      where nl.appointment_id = al.target_id
        and nl.event = 'appointment_auto_cancelled_missed_checkin'
    )
  order by appointment_id
  limit greatest(coalesce(p_limit, 100), 1);
$$;

revoke all on function public.list_auto_cancel_missed_sms_due(integer) from public;
grant execute on function public.list_auto_cancel_missed_sms_due(integer) to service_role;
