-- ============================================================
-- 0001_initial_schema.sql
-- MHO Centralized Appointment & Ticketing System — core schema.
-- Source of truth: docs/project_context.md section 5.
-- Appointment-scoped ONLY: no clinical/EMR fields anywhere.
-- ============================================================

-- pgcrypto provides gen_random_bytes / crypt / gen_salt. On Supabase
-- extensions live in the `extensions` schema — install it there
-- explicitly so its location is predictable. NOTE: any function with
-- a pinned search_path that calls pgcrypto at runtime must include
-- `extensions` in that search_path (see 0003).
-- (gen_random_uuid() is core Postgres — it does NOT need pgcrypto.)
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------
-- profiles — one row per auth user, all roles
-- ------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null,
  role        text not null default 'patient'
              check (role in ('patient', 'doctor', 'nurse', 'staff', 'admin')),
  phone       text,
  email       text,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- patients — extra patient-only info (appointment-scoped)
-- ------------------------------------------------------------
create table public.patients (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null unique references public.profiles (id) on delete cascade,
  birthdate   date,
  address     text,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- providers — doctors / nurses / dentist
-- ------------------------------------------------------------
create table public.providers (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null unique references public.profiles (id) on delete cascade,
  provider_type   text not null check (provider_type in ('doctor', 'nurse', 'dentist')),
  specialization  text,
  created_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- services
-- ------------------------------------------------------------
create table public.services (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  description  text,
  active       boolean not null default true
);

-- ------------------------------------------------------------
-- provider_availability — weekly recurring windows
-- day_of_week: 0 = Sunday … 6 = Saturday (Postgres EXTRACT(DOW) convention)
-- ------------------------------------------------------------
create table public.provider_availability (
  id           uuid primary key default gen_random_uuid(),
  provider_id  uuid not null references public.providers (id) on delete cascade,
  day_of_week  smallint not null check (day_of_week between 0 and 6),
  start_time   time not null,
  end_time     time not null,
  created_at   timestamptz not null default now(),
  check (end_time > start_time),
  unique (provider_id, day_of_week, start_time)
);

-- ------------------------------------------------------------
-- time_slots — generated bookable slots
-- ------------------------------------------------------------
create table public.time_slots (
  id             uuid primary key default gen_random_uuid(),
  provider_id    uuid not null references public.providers (id) on delete cascade,
  service_id     uuid not null references public.services (id),
  slot_datetime  timestamptz not null,
  is_booked      boolean not null default false,
  unique (provider_id, slot_datetime)
);

-- ------------------------------------------------------------
-- appointments
-- Booking/cancel/reschedule happen ONLY through SECURITY DEFINER
-- RPCs (Step 3) so the is_booked check-and-set is race-safe.
-- ------------------------------------------------------------
create table public.appointments (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.patients (id),
  provider_id  uuid not null references public.providers (id),
  service_id   uuid not null references public.services (id),
  slot_id      uuid not null references public.time_slots (id),
  status       text not null default 'booked'
               check (status in ('booked', 'checked_in', 'served', 'cancelled', 'no_show')),
  booked_at    timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- Second line of defense against double booking (first is the RPC
-- lock): at most ONE non-cancelled appointment per slot. Partial so
-- a cancelled slot can be rebooked.
create unique index uniq_active_appointment_per_slot
  on public.appointments (slot_id)
  where status <> 'cancelled';

-- ------------------------------------------------------------
-- queue_tickets
-- ------------------------------------------------------------
create table public.queue_tickets (
  id              uuid primary key default gen_random_uuid(),
  appointment_id  uuid not null unique references public.appointments (id) on delete cascade,
  ticket_number   text not null,
  queue_position  integer not null,
  status          text not null default 'waiting'
                  check (status in ('waiting', 'now_serving', 'done')),
  qr_code         text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  created_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- announcements
-- ------------------------------------------------------------
create table public.announcements (
  id          uuid primary key default gen_random_uuid(),
  posted_by   uuid references public.profiles (id) on delete set null,
  title       text not null,
  body        text not null,
  published   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- notifications
-- ------------------------------------------------------------
create table public.notifications (
  id              uuid primary key default gen_random_uuid(),
  appointment_id  uuid not null references public.appointments (id) on delete cascade,
  type            text not null check (type in ('sms', 'email')),
  purpose         text not null check (purpose in ('confirmation', 'reminder')),
  status          text not null default 'pending'
                  check (status in ('pending', 'sent', 'failed', 'mocked')),
  scheduled_for   timestamptz,
  sent_at         timestamptz
);

-- ------------------------------------------------------------
-- audit_log
-- ------------------------------------------------------------
create table public.audit_log (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid references public.profiles (id) on delete set null,
  action        text not null,
  target_table  text,
  target_id     uuid,
  created_at    timestamptz not null default now()
);

-- ============================================================
-- Indexes for the hot query paths
-- (unique constraints above already index: time_slots(provider_id,
--  slot_datetime), queue_tickets(appointment_id), etc.)
-- ============================================================

-- Patient opens "my appointments"
create index idx_appointments_patient on public.appointments (patient_id);

-- Provider schedule view / staff filtering by status
create index idx_appointments_provider_status on public.appointments (provider_id, status);

-- Availability search: "open slots for service X from date Y"
create index idx_time_slots_open
  on public.time_slots (service_id, slot_datetime)
  where not is_booked;

-- Queue board: waiting/now_serving ordered by position
create index idx_queue_tickets_status_position
  on public.queue_tickets (status, queue_position);

-- Weekly availability lookup per provider (covered by the unique
-- constraint's index prefix, but explicit for the day-only lookup)
create index idx_provider_availability_day
  on public.provider_availability (day_of_week);

-- Reminder sender: "pending notifications due before now"
create index idx_notifications_due
  on public.notifications (scheduled_for)
  where status = 'pending';

-- Public announcement feed
create index idx_announcements_feed
  on public.announcements (created_at desc)
  where published;

-- Audit trail lookups
create index idx_audit_log_target on public.audit_log (target_table, target_id);

-- ============================================================
-- New-user trigger: auth.users insert → profiles row (+ patients
-- row when the role is patient).
--
-- SECURITY: role is read from raw_APP_meta_data, which clients can
-- NEVER set (only the service role / admin API can). Self-signup
-- always lands as 'patient'. Staff accounts are created by the
-- admin with app_metadata.role set server-side.
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_role text := coalesce(new.raw_app_meta_data ->> 'role', 'patient');
begin
  insert into public.profiles (id, full_name, role, phone, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new_role,
    new.raw_user_meta_data ->> 'phone',
    new.email
  );

  if new_role = 'patient' then
    insert into public.patients (profile_id) values (new.id);
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
