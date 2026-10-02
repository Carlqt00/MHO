-- ============================================================
-- 0026_profiles_alternate_email.sql
-- Optional backup email for patient profile display.
--
-- This is contact information only. Supabase Auth/login email remains
-- profiles.email and is updated through the Auth email-change flow.
-- ============================================================

alter table public.profiles
  add column if not exists alternate_email text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_alternate_email_format_chk'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_alternate_email_format_chk
      check (alternate_email is null or alternate_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
  end if;
end $$;
