-- ============================================================
-- 0007_queue_board.sql — Step 4: live queue board (staff/nurse).
--
-- 1. Widen NURSE read access (RBAC "assist patient flow"): the
--    board joins queue_tickets → appointments → patients → profiles,
--    but nurses could only see THEIR OWN appointments (provider
--    policy), so other doctors' queues would render empty.
--    Writes stay staff/admin-only; nurse advance goes through the
--    RPC below.
-- 2. advance_queue RPC — atomic "call next" (advisory lock so two
--    staff clicking simultaneously can't double-advance).
-- 3. cancel_appointment now also closes the queue ticket (Step 3
--    gap: cancelled bookings left a ghost 'waiting' ticket).
-- 4. Realtime enabled on queue_tickets (signal-only on the client).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Nurse read policies
-- ------------------------------------------------------------
create policy "nurse: select all appointments"
  on public.appointments for select to authenticated
  using (public.my_role() = 'nurse');

create policy "nurse: select all patients"
  on public.patients for select to authenticated
  using (public.my_role() = 'nurse');

create policy "nurse: select all profiles"
  on public.profiles for select to authenticated
  using (public.my_role() = 'nurse');

-- ------------------------------------------------------------
-- 2. advance_queue(p_provider_id)
-- Finishes the current now_serving ticket (marks it done, its
-- appointment served) and promotes the lowest-position waiting
-- ticket to now_serving. Scoped to one provider + today (Manila).
-- Returns the promoted ticket, or null when the queue is empty.
-- Allowed: nurse, staff, admin.
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
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role not in ('nurse', 'staff', 'admin') then
    raise exception 'ERR_FORBIDDEN: only clinic personnel can advance the queue';
  end if;

  -- Serialize per provider: two staff clicking "call next" at the
  -- same moment cannot double-advance.
  perform pg_advisory_xact_lock(hashtextextended(p_provider_id::text, 0));

  -- Finish whoever is currently being served (today, this provider)
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
  end if;

  -- Promote the next waiting ticket
  select qt.id, qt.ticket_number, qt.queue_position
  into v_next
  from queue_tickets qt
  join appointments a on a.id = qt.appointment_id
  join time_slots ts on ts.id = a.slot_id
  where a.provider_id = p_provider_id
    and qt.status = 'waiting'
    and a.status <> 'cancelled'
    and (ts.slot_datetime at time zone 'Asia/Manila')::date
      = (now() at time zone 'Asia/Manila')::date
  order by qt.queue_position
  limit 1;

  if not found then
    return null; -- queue empty for this provider today
  end if;

  update queue_tickets set status = 'now_serving' where id = v_next.id;

  insert into audit_log (actor_id, action, target_table, target_id)
  values (auth.uid(), 'advance_queue', 'queue_tickets', v_next.id);

  return jsonb_build_object(
    'ticket_id',      v_next.id,
    'ticket_number',  v_next.ticket_number,
    'queue_position', v_next.queue_position
  );
end;
$$;

grant execute on function public.advance_queue(uuid) to authenticated;

-- ------------------------------------------------------------
-- 3. cancel_appointment: also close the queue ticket
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

  if v_role = 'patient' and v_appt.profile_id <> auth.uid() then
    raise exception 'ERR_FORBIDDEN: cannot cancel another patient''s appointment';
  end if;

  if v_appt.status not in ('booked', 'checked_in') then
    raise exception 'ERR_INVALID_STATUS: cannot cancel a % appointment', v_appt.status;
  end if;

  update appointments set status = 'cancelled' where id = p_appointment_id;
  update time_slots set is_booked = false where id = v_appt.slot_id;

  -- Close the ticket so it disappears from the queue board
  update queue_tickets
  set status = 'done'
  where appointment_id = p_appointment_id
    and status in ('waiting', 'now_serving');

  insert into audit_log (actor_id, action, target_table, target_id)
  values (auth.uid(), 'cancel_appointment', 'appointments', p_appointment_id);
end;
$$;

-- ------------------------------------------------------------
-- 4. Realtime on queue_tickets.
-- replica identity full → realtime can authorize UPDATE events
-- against RLS. Publication add is guarded for idempotent re-runs.
-- ------------------------------------------------------------
alter table public.queue_tickets replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.queue_tickets;
exception
  when duplicate_object then null;
end;
$$;
