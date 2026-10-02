-- ============================================================
-- 0027_profile_contacts.sql
-- Normalized additional contact records for patient profiles.
--
-- profiles.email and profiles.phone remain the primary/login/SMS contacts.
-- profile_contacts stores backup contact information only.
-- ============================================================

create table if not exists public.profile_contacts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  contact_type text not null check (contact_type in ('email', 'phone')),
  contact_value text not null,
  created_at timestamptz not null default now(),
  check (
    (contact_type = 'email' and contact_value ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    or
    (contact_type = 'phone' and contact_value ~ '^\+639\d{9}$')
  )
);

create unique index if not exists profile_contacts_profile_type_value_uidx
  on public.profile_contacts (profile_id, contact_type, lower(contact_value));

alter table public.profile_contacts enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profile_contacts'
      and policyname = 'own profile contacts: select'
  ) then
    create policy "own profile contacts: select"
      on public.profile_contacts for select to authenticated
      using (profile_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profile_contacts'
      and policyname = 'own profile contacts: insert'
  ) then
    create policy "own profile contacts: insert"
      on public.profile_contacts for insert to authenticated
      with check (profile_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profile_contacts'
      and policyname = 'own profile contacts: delete'
  ) then
    create policy "own profile contacts: delete"
      on public.profile_contacts for delete to authenticated
      using (profile_id = auth.uid());
  end if;
end $$;

insert into public.profile_contacts (profile_id, contact_type, contact_value)
select p.id, 'email', lower(trim(p.alternate_email))
from public.profiles p
where nullif(trim(coalesce(p.alternate_email, '')), '') is not null
  and lower(trim(p.alternate_email)) <> lower(trim(coalesce(p.email, '')))
  and not exists (
    select 1
    from public.profile_contacts pc
    where pc.profile_id = p.id
      and pc.contact_type = 'email'
      and lower(pc.contact_value) = lower(trim(p.alternate_email))
  );

insert into public.profile_contacts (profile_id, contact_type, contact_value)
select p.id, 'phone', p.alternate_phone
from public.profiles p
where nullif(trim(coalesce(p.alternate_phone, '')), '') is not null
  and p.alternate_phone <> coalesce(p.phone, '')
  and not exists (
    select 1
    from public.profile_contacts pc
    where pc.profile_id = p.id
      and pc.contact_type = 'phone'
      and pc.contact_value = p.alternate_phone
  );
