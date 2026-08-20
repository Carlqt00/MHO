-- ============================================================
-- seed.sql — Daraga MHO demo data (manuscript Tables 1 & 2)
--
-- Staff:    3 doctors, 1 dentist, 5 nurses (+1 staff, +1 admin)
-- Hours:    Mon–Fri 8AM–4PM | Sat 8AM–3PM | Sun 8AM–11AM
-- Services: Immunization, Prenatal, General Check-up, Dental
-- Patients: 3 demo patients
--
-- All accounts use password: demo1234
-- Emails match the Step 1 mock users (patient@demo.mho etc.) so the
-- Supabase auth swap keeps the exact same demo logins.
--
-- HOW TO RUN: `supabase db reset` picks this up automatically on
-- local dev. On hosted Supabase, run it once in the SQL Editor.
-- Inserting into auth.users directly is a LOCAL/DEV shortcut — for
-- a production instance create users via the dashboard/admin API.
-- The on_auth_user_created trigger auto-creates profiles (and the
-- patients row for patient-role users); role comes from
-- raw_app_meta_data which only the server can set.
-- ============================================================

-- ------------------------------------------------------------
-- Auth users (trigger fills public.profiles / public.patients)
-- ------------------------------------------------------------
insert into auth.users
  (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  -- Doctors (3)
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'doctor@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"doctor"}',
   '{"full_name":"Dr. Maria Santos","phone":"09170000001"}', now(), now()),
  ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'doctor2@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"doctor"}',
   '{"full_name":"Dr. Jose Ramirez","phone":"09170000002"}', now(), now()),
  ('a0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'doctor3@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"doctor"}',
   '{"full_name":"Dr. Carmen Lopez","phone":"09170000003"}', now(), now()),

  -- Dentist (1)
  ('a0000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'dentist@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"doctor"}',
   '{"full_name":"Dr. Ricardo Uy, DMD","phone":"09170000004"}', now(), now()),

  -- Nurses (5)
  ('a0000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'nurse@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"nurse"}',
   '{"full_name":"Ana Reyes, RN","phone":"09170000005"}', now(), now()),
  ('a0000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'nurse2@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"nurse"}',
   '{"full_name":"Grace Bautista, RN","phone":"09170000006"}', now(), now()),
  ('a0000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'nurse3@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"nurse"}',
   '{"full_name":"Marites Dizon, RN","phone":"09170000007"}', now(), now()),
  ('a0000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'nurse4@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"nurse"}',
   '{"full_name":"Joan Padilla, RN","phone":"09170000008"}', now(), now()),
  ('a0000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'nurse5@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"nurse"}',
   '{"full_name":"Rowena Salcedo, RN","phone":"09170000009"}', now(), now()),

  -- Healthcare staff (1)
  ('a0000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'staff@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"staff"}',
   '{"full_name":"Pedro Ramos","phone":"09170000010"}', now(), now()),

  -- Administrator (1)
  ('a0000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'admin@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"admin"}',
   '{"full_name":"Liza Villanueva","phone":"09170000011"}', now(), now()),

  -- Demo patients (3)
  ('b0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'patient@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"patient"}',
   '{"full_name":"Juan Dela Cruz","phone":"09180000001"}', now(), now()),
  ('b0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'patient2@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"patient"}',
   '{"full_name":"Elena Marquez","phone":"09180000002"}', now(), now()),
  ('b0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'patient3@demo.mho', crypt('demo1234', gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"],"role":"patient"}',
   '{"full_name":"Ramon Buenaventura","phone":"09180000003"}', now(), now());

-- ------------------------------------------------------------
-- Providers (profiles already created by the trigger)
-- ------------------------------------------------------------
insert into public.providers (profile_id, provider_type, specialization)
values
  ('a0000000-0000-0000-0000-000000000001', 'doctor',  'General Medicine'),
  ('a0000000-0000-0000-0000-000000000002', 'doctor',  'Pediatrics / Immunization'),
  ('a0000000-0000-0000-0000-000000000003', 'doctor',  'Obstetrics / Prenatal Care'),
  ('a0000000-0000-0000-0000-000000000004', 'dentist', 'General Dentistry'),
  ('a0000000-0000-0000-0000-000000000005', 'nurse',   null),
  ('a0000000-0000-0000-0000-000000000006', 'nurse',   null),
  ('a0000000-0000-0000-0000-000000000007', 'nurse',   null),
  ('a0000000-0000-0000-0000-000000000008', 'nurse',   null),
  ('a0000000-0000-0000-0000-000000000009', 'nurse',   null);

-- ------------------------------------------------------------
-- Demo patient details (rows created by trigger; fill in extras)
-- ------------------------------------------------------------
update public.patients set birthdate = '1988-06-24', address = 'Brgy. San Roque, Daraga, Albay'
  where profile_id = 'b0000000-0000-0000-0000-000000000001';
update public.patients set birthdate = '1995-11-02', address = 'Brgy. Bagumbayan, Daraga, Albay'
  where profile_id = 'b0000000-0000-0000-0000-000000000002';
update public.patients set birthdate = '1972-03-15', address = 'Brgy. Tagas, Daraga, Albay'
  where profile_id = 'b0000000-0000-0000-0000-000000000003';

-- ------------------------------------------------------------
-- Services
-- ------------------------------------------------------------
insert into public.services (name, description) values
  ('Immunization',     'Bakuna para sa mga bata at matatanda (childhood and adult vaccines)'),
  ('Prenatal',         'Prenatal check-up para sa mga buntis (maternal care visits)'),
  ('General Check-up', 'Pangkalahatang konsulta (general medical consultation)'),
  ('Dental',           'Serbisyong dental — bunot, linis, at konsulta (extraction, cleaning, consultation)');

-- ------------------------------------------------------------
-- Provider availability — MHO facility hours
--   Mon–Fri 8AM–4PM | Sat 8AM–3PM | Sun 8AM–11AM
--   day_of_week: 0 = Sunday … 6 = Saturday
-- Doctors & dentist: Mon–Fri. Doctors also rotate Saturdays.
-- Nurses: all seven days (they cover Sunday half-days).
-- ------------------------------------------------------------

-- Weekdays 8–4 for every provider
insert into public.provider_availability (provider_id, day_of_week, start_time, end_time)
select p.id, d, time '08:00', time '16:00'
from public.providers p
cross join generate_series(1, 5) as d;

-- Saturdays 8–3: doctors and nurses
insert into public.provider_availability (provider_id, day_of_week, start_time, end_time)
select p.id, 6, time '08:00', time '15:00'
from public.providers p
where p.provider_type in ('doctor', 'nurse');

-- Sundays 8–11: nurses only
insert into public.provider_availability (provider_id, day_of_week, start_time, end_time)
select p.id, 0, time '08:00', time '11:00'
from public.providers p
where p.provider_type = 'nurse';

-- ------------------------------------------------------------
-- GoTrue compatibility repair (REQUIRED for login to work).
-- Directly-inserted auth.users rows leave token columns NULL and
-- have no auth.identities row; GoTrue then 500s on login.
-- ------------------------------------------------------------
update auth.users set
  confirmation_token         = coalesce(confirmation_token, ''),
  recovery_token             = coalesce(recovery_token, ''),
  email_change               = coalesce(email_change, ''),
  email_change_token_new     = coalesce(email_change_token_new, ''),
  email_change_token_current = coalesce(email_change_token_current, ''),
  phone_change               = coalesce(phone_change, ''),
  phone_change_token         = coalesce(phone_change_token, ''),
  reauthentication_token     = coalesce(reauthentication_token, '')
where email like '%@demo.mho';

insert into auth.identities
  (user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select
  u.id,
  u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email',
  now(), now(), now()
from auth.users u
where u.email like '%@demo.mho'
  and not exists (select 1 from auth.identities i where i.user_id = u.id);
