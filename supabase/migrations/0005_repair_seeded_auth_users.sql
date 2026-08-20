-- ============================================================
-- 0005_repair_seeded_auth_users.sql
-- Repair for users inserted directly into auth.users by seed.sql.
--
-- ROOT CAUSE: GoTrue (Supabase auth server) cannot scan NULL values
-- in several text columns of auth.users ("converting NULL to string
-- is unsupported") and expects an auth.identities row per user.
-- Dashboard-created users get all of this automatically; our seed
-- insert left the token columns NULL and created no identities —
-- so login returns HTTP 500 with an empty error body, which the
-- client renders as "{}".
--
-- DIAGNOSTIC (run first — confirms the problem):
--   select email,
--          confirmation_token is null as tok_null,
--          (select count(*) from auth.identities i where i.user_id = u.id) as identities
--   from auth.users u
--   where email like '%@demo.mho';
-- Problem confirmed if tok_null = true or identities = 0.
-- ============================================================

-- 1. Blank out the NULL token columns GoTrue chokes on
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

-- 2. Create the missing email identities
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
