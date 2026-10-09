-- ============================================================
-- 0036_profile_default_contact_promotions.sql
-- Atomic profile contact swaps for Set as Default actions.
-- ============================================================

create or replace function public.promote_default_phone_contact(p_phone text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid := auth.uid();
  v_promoted text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_old_phone text;
begin
  if v_profile_id is null then
    raise exception 'ERR_NOT_AUTHENTICATED: login required';
  end if;

  if v_promoted like '63%' then
    v_promoted := substring(v_promoted from 3);
  elsif v_promoted like '0%' then
    v_promoted := substring(v_promoted from 2);
  end if;
  v_promoted := substring(v_promoted from 1 for 10);

  if v_promoted !~ '^9\d{9}$' then
    raise exception 'ERR_INVALID_PHONE: valid Philippine cellphone number required';
  end if;
  v_promoted := '+63' || v_promoted;

  select phone
  into v_old_phone
  from public.profiles
  where id = v_profile_id
  for update;

  if not found then
    raise exception 'ERR_NOT_FOUND: profile not found';
  end if;

  if coalesce(v_old_phone, '') = v_promoted then
    raise exception 'ERR_SAME_PHONE: this is already your default cellphone number';
  end if;

  if not exists (
    select 1
    from public.profile_contacts pc
    where pc.profile_id = v_profile_id
      and pc.contact_type = 'phone'
      and pc.contact_value = v_promoted
  ) then
    raise exception 'ERR_CONTACT_NOT_FOUND: additional contact number not found';
  end if;

  update public.profiles
  set phone = v_promoted
  where id = v_profile_id;

  delete from public.profile_contacts pc
  where pc.profile_id = v_profile_id
    and pc.contact_type = 'phone'
    and pc.contact_value = v_promoted;

  if nullif(v_old_phone, '') is not null and v_old_phone <> v_promoted then
    insert into public.profile_contacts (profile_id, contact_type, contact_value)
    values (v_profile_id, 'phone', v_old_phone)
    on conflict do nothing;
  end if;
end;
$$;

grant execute on function public.promote_default_phone_contact(text) to authenticated;

create or replace function public.promote_default_email_contact(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid := auth.uid();
  v_promoted text := lower(trim(coalesce(p_email, '')));
  v_old_email text;
begin
  if v_profile_id is null then
    raise exception 'ERR_NOT_AUTHENTICATED: login required';
  end if;

  if v_promoted !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'ERR_INVALID_EMAIL: valid email required';
  end if;

  select lower(trim(coalesce(email, '')))
  into v_old_email
  from public.profiles
  where id = v_profile_id
  for update;

  if not found then
    raise exception 'ERR_NOT_FOUND: profile not found';
  end if;

  if coalesce(v_old_email, '') = v_promoted then
    raise exception 'ERR_SAME_EMAIL: this is already your default email';
  end if;

  if not exists (
    select 1
    from public.profile_contacts pc
    where pc.profile_id = v_profile_id
      and pc.contact_type = 'email'
      and lower(pc.contact_value) = v_promoted
  ) then
    raise exception 'ERR_CONTACT_NOT_FOUND: additional email not found';
  end if;

  update public.profiles
  set email = v_promoted
  where id = v_profile_id;

  delete from public.profile_contacts pc
  where pc.profile_id = v_profile_id
    and pc.contact_type = 'email'
    and lower(pc.contact_value) = v_promoted;

  if nullif(v_old_email, '') is not null and v_old_email <> v_promoted then
    insert into public.profile_contacts (profile_id, contact_type, contact_value)
    values (v_profile_id, 'email', v_old_email)
    on conflict do nothing;
  end if;
end;
$$;

grant execute on function public.promote_default_email_contact(text) to authenticated;
