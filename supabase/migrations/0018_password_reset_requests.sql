-- ============================================================
-- 0018_password_reset_requests.sql
-- In-system password reset requests, reviewed by administrators.
-- Password changes still happen only through Supabase Auth APIs.
-- ============================================================

alter table public.profiles
  add column if not exists password_change_required boolean not null default false;

create table if not exists public.password_reset_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'rejected')),
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists uniq_pending_password_reset_per_profile
  on public.password_reset_requests (profile_id)
  where status = 'pending';

create index if not exists idx_password_reset_requests_status_requested
  on public.password_reset_requests (status, requested_at desc);

alter table public.password_reset_requests enable row level security;

create policy "admin: select password reset requests"
  on public.password_reset_requests for select to authenticated
  using (public.is_admin());

-- Writes are performed by Edge Functions using the service role. No client
-- insert/update/delete policies are granted, and anon users never write
-- directly into this table.
