-- ============================================================
-- 0025_profiles_alternate_phone.sql
-- Optional alternate contact number for patient profile display.
--
-- SMS flows continue to use profiles.phone only. This nullable field is an
-- informational backup contact and follows the same canonical PH mobile
-- format as profiles.phone: +639XXXXXXXXX.
-- ============================================================

alter table public.profiles
  add column if not exists alternate_phone text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_alternate_phone_ph_format_chk'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_alternate_phone_ph_format_chk
      check (alternate_phone is null or alternate_phone ~ '^\+639\d{9}$');
  end if;
end $$;
