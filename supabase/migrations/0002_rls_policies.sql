-- ============================================================
-- 0002_rls_policies.sql
-- Row Level Security for every table, enforcing the RBAC table in
-- docs/project_context.md section 4.
--
-- Core invariant: a patient must NEVER see another patient's data.
--
-- Deny-by-default: RLS is enabled on all tables and anything not
-- explicitly granted below is blocked. Writes that need atomicity
-- (booking, queue advance) get NO client policies — they go through
-- SECURITY DEFINER RPCs in Step 3, or the service role.
-- ============================================================

-- ------------------------------------------------------------
-- Helper functions.
-- SECURITY DEFINER so they read the tables without re-triggering
-- RLS (avoids recursive policy evaluation); STABLE so the planner
-- caches them per-statement.
-- ------------------------------------------------------------

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select public.my_role() = 'admin'
$$;

create or replace function public.is_staff_or_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select public.my_role() in ('staff', 'admin')
$$;

create or replace function public.my_patient_id()
returns uuid language sql stable security definer set search_path = public
as $$
  select id from public.patients where profile_id = auth.uid()
$$;

create or replace function public.my_provider_id()
returns uuid language sql stable security definer set search_path = public
as $$
  select id from public.providers where profile_id = auth.uid()
$$;

-- Does the calling provider have an appointment with this person?
-- (Lets doctors/nurses see names of THEIR patients only.)
create or replace function public.provider_has_appointment_with(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.appointments a
    join public.patients pt on pt.id = a.patient_id
    where pt.profile_id = p_profile_id
      and a.provider_id = public.my_provider_id()
  )
$$;

create or replace function public.provider_has_appointment_with_patient(p_patient_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.appointments a
    where a.patient_id = p_patient_id
      and a.provider_id = public.my_provider_id()
  )
$$;

-- ------------------------------------------------------------
-- Guard: nobody but an admin may change a profile's role.
-- (Blocks privilege escalation through the "update own profile"
-- policy below.)
-- ------------------------------------------------------------
create or replace function public.prevent_role_escalation()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  -- auth.uid() is null for server-side contexts (service role, SQL
  -- editor) — those stay allowed; user-scoped requests need admin.
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'Only an administrator can change roles';
  end if;
  return new;
end;
$$;

create trigger profiles_prevent_role_escalation
  before update on public.profiles
  for each row execute function public.prevent_role_escalation();

-- ------------------------------------------------------------
-- Enable RLS everywhere
-- ------------------------------------------------------------
alter table public.profiles              enable row level security;
alter table public.patients              enable row level security;
alter table public.providers             enable row level security;
alter table public.services              enable row level security;
alter table public.provider_availability enable row level security;
alter table public.time_slots            enable row level security;
alter table public.appointments          enable row level security;
alter table public.queue_tickets         enable row level security;
alter table public.announcements         enable row level security;
alter table public.notifications         enable row level security;
alter table public.audit_log             enable row level security;

-- ------------------------------------------------------------
-- profiles
-- ------------------------------------------------------------
create policy "own profile: select"
  on public.profiles for select to authenticated
  using (id = auth.uid());

create policy "staff/admin: select all profiles"
  on public.profiles for select to authenticated
  using (public.is_staff_or_admin());

create policy "provider: select profiles of own patients"
  on public.profiles for select to authenticated
  using (public.provider_has_appointment_with(id));

create policy "own profile: update"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
  -- role changes additionally blocked by profiles_prevent_role_escalation

create policy "admin: update any profile"
  on public.profiles for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- inserts happen only via the on_auth_user_created trigger (definer)
-- deletes happen only via auth.users cascade — no client policies

-- ------------------------------------------------------------
-- patients
-- ------------------------------------------------------------
create policy "patient: select own record"
  on public.patients for select to authenticated
  using (profile_id = auth.uid());

create policy "staff/admin: select all patients"
  on public.patients for select to authenticated
  using (public.is_staff_or_admin());

create policy "provider: select own appointment patients"
  on public.patients for select to authenticated
  using (public.provider_has_appointment_with_patient(id));

create policy "patient: update own record"
  on public.patients for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy "staff/admin: update patients"
  on public.patients for update to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

create policy "staff/admin: insert patients"  -- walk-in registration at the desk
  on public.patients for insert to authenticated
  with check (public.is_staff_or_admin());

-- ------------------------------------------------------------
-- providers — directory is public to logged-in users (needed to
-- pick a doctor when booking); only admin manages the roster
-- ------------------------------------------------------------
create policy "authenticated: select providers"
  on public.providers for select to authenticated
  using (true);

create policy "admin: manage providers"
  on public.providers for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ------------------------------------------------------------
-- services — active services visible even before login (landing
-- page); admin manages
-- ------------------------------------------------------------
create policy "anon: select active services"
  on public.services for select to anon
  using (active);

create policy "authenticated: select services"
  on public.services for select to authenticated
  using (true);

create policy "admin: manage services"
  on public.services for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ------------------------------------------------------------
-- provider_availability — providers manage their OWN windows
-- (RBAC: doctor/nurse "set/manage own availability"); admin all
-- ------------------------------------------------------------
create policy "authenticated: select availability"
  on public.provider_availability for select to authenticated
  using (true);

create policy "provider: manage own availability"
  on public.provider_availability for all to authenticated
  using (provider_id = public.my_provider_id())
  with check (provider_id = public.my_provider_id());

create policy "admin: manage availability"
  on public.provider_availability for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ------------------------------------------------------------
-- time_slots — readable by all logged-in users (booking UI);
-- slot generation is admin-only; is_booked flips ONLY inside the
-- race-safe booking RPC (Step 3), never from the client
-- ------------------------------------------------------------
create policy "authenticated: select time slots"
  on public.time_slots for select to authenticated
  using (true);

create policy "admin: manage time slots"
  on public.time_slots for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ------------------------------------------------------------
-- appointments — patient sees ONLY their own; provider sees only
-- those assigned to them; staff/admin see all and update statuses.
-- NO client insert policy: booking goes through the Step 3 RPC.
-- ------------------------------------------------------------
create policy "patient: select own appointments"
  on public.appointments for select to authenticated
  using (patient_id = public.my_patient_id());

create policy "provider: select own appointments"
  on public.appointments for select to authenticated
  using (provider_id = public.my_provider_id());

create policy "staff/admin: select all appointments"
  on public.appointments for select to authenticated
  using (public.is_staff_or_admin());

create policy "staff/admin: update appointments"
  on public.appointments for update to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

-- ------------------------------------------------------------
-- queue_tickets — patient sees own ticket; nurse/staff/admin see
-- the whole board (nurse "assists patient flow"); staff/admin
-- advance the queue. Ticket creation via the booking RPC.
-- ------------------------------------------------------------
create policy "patient: select own tickets"
  on public.queue_tickets for select to authenticated
  using (
    appointment_id in (
      select id from public.appointments
      where patient_id = public.my_patient_id()
    )
  );

create policy "nurse/staff/admin: select all tickets"
  on public.queue_tickets for select to authenticated
  using (public.my_role() in ('nurse', 'staff', 'admin'));

create policy "staff/admin: update tickets"
  on public.queue_tickets for update to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

-- ------------------------------------------------------------
-- announcements — published ones are public (even logged out);
-- admin manages (RBAC: announcements are an Administrator power)
-- ------------------------------------------------------------
create policy "anyone: select published announcements"
  on public.announcements for select to anon, authenticated
  using (published);

create policy "admin: manage announcements"
  on public.announcements for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ------------------------------------------------------------
-- notifications — patient sees own; staff/admin see all; ONLY the
-- server (service role / scheduled function) writes — no policies
-- ------------------------------------------------------------
create policy "patient: select own notifications"
  on public.notifications for select to authenticated
  using (
    appointment_id in (
      select id from public.appointments
      where patient_id = public.my_patient_id()
    )
  );

create policy "staff/admin: select all notifications"
  on public.notifications for select to authenticated
  using (public.is_staff_or_admin());

-- ------------------------------------------------------------
-- audit_log — admin reads; writes only from SECURITY DEFINER
-- functions / service role
-- ------------------------------------------------------------
create policy "admin: select audit log"
  on public.audit_log for select to authenticated
  using (public.is_admin());
