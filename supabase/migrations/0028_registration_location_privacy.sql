-- ============================================================
-- 0028_registration_location_privacy.sql
-- Registration location fields and privacy-consent record.
--
-- Existing accounts remain valid with null values. New patient registration
-- requires these fields in the application before Supabase Auth signup.
-- ============================================================

alter table public.profiles
  add column if not exists barangay text,
  add column if not exists purok text,
  add column if not exists privacy_consent_at timestamptz,
  add column if not exists privacy_notice_version text;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_role text := coalesce(new.raw_app_meta_data ->> 'role', 'patient');
  consent_version text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'privacy_notice_version', '')), '');
begin
  insert into public.profiles (
    id,
    full_name,
    role,
    phone,
    email,
    barangay,
    purok,
    privacy_consent_at,
    privacy_notice_version
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new_role,
    new.raw_user_meta_data ->> 'phone',
    new.email,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'barangay', '')), ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'purok', '')), ''),
    case
      when (new.raw_user_meta_data ->> 'privacy_consent_accepted')::boolean is true
        then now()
      else null
    end,
    consent_version
  );

  if new_role = 'patient' then
    insert into public.patients (profile_id) values (new.id);
  end if;

  return new;
end;
$$;
