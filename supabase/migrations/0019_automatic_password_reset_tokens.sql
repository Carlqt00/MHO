-- ============================================================
-- 0019_automatic_password_reset_tokens.sql
-- Automatic, user-completed password reset authorization.
-- ============================================================

alter table public.password_reset_requests
  add column if not exists approved_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists token_hash text,
  add column if not exists token_expires_at timestamptz,
  add column if not exists token_used_at timestamptz;

do $$
declare
  v_constraint_name text;
begin
  select conname into v_constraint_name
  from pg_constraint
  where conrelid = 'public.password_reset_requests'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%status%'
    and pg_get_constraintdef(oid) like '%pending%'
    and pg_get_constraintdef(oid) like '%completed%'
    and pg_get_constraintdef(oid) like '%rejected%'
  limit 1;

  if v_constraint_name is not null then
    execute format(
      'alter table public.password_reset_requests drop constraint %I',
      v_constraint_name
    );
  end if;
end $$;

alter table public.password_reset_requests
  add constraint password_reset_requests_status_chk
  check (status in ('pending', 'approved', 'completed', 'rejected', 'expired', 'failed'));

create unique index if not exists uniq_active_password_reset_per_profile
  on public.password_reset_requests (profile_id)
  where status in ('pending', 'approved');

create index if not exists idx_password_reset_requests_token_hash
  on public.password_reset_requests (token_hash)
  where status = 'approved' and token_used_at is null;
