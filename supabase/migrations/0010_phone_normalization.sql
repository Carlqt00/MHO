-- ============================================================
-- 0010_phone_normalization.sql
-- Canonicalize profiles.phone to +639XXXXXXXXX and enforce it.
--
-- Registration now assembles the +63 prefix client-side at submit and
-- stores the canonical form; this migration brings any pre-existing /
-- seeded rows into the same shape and adds a CHECK constraint so the
-- format can never drift again. Client validation is UX only — THIS
-- constraint is the real enforcement.
--
-- Canonical form: '+63' followed by the 10-digit subscriber number,
-- which always starts with 9 (PH mobile). Never a bare 10 digits,
-- never a leading 0.
--
-- Idempotent / re-runnable: the UPDATE only touches rows whose canonical
-- form differs from what's stored (a true no-op once clean), and the
-- constraint is added inside a guard so a live DB that already has it
-- won't raise 42710 (duplicate_object).
-- ============================================================

-- ------------------------------------------------------------
-- Normalize existing values. Mirrors the client's normalization:
--   1. strip everything but digits (spaces, dashes, '+', etc.)
--   2. drop a leading '63' (country code) or a leading '0' (trunk),
--      leaving the bare 10-digit subscriber number
--   3. re-assemble as '+63' + subscriber
-- Only rows that reduce to a valid 10-digit number starting with 9 are
-- rewritten; anything else (and NULLs) is left as-is so genuinely bad
-- data surfaces against the constraint below instead of being masked.
-- No-op against the current live data (all rows already canonical).
-- ------------------------------------------------------------
update public.profiles p
set phone = '+63' || sub.subscriber
from (
  select
    id,
    case
      when d like '63%' then substr(d, 3)
      when d like '0%'  then substr(d, 2)
      else d
    end as subscriber
  from (
    select id, regexp_replace(phone, '\D', '', 'g') as d
    from public.profiles
    where phone is not null
  ) stripped
) sub
where p.id = sub.id
  and sub.subscriber ~ '^9\d{9}$'
  and p.phone is distinct from '+63' || sub.subscriber;

-- ------------------------------------------------------------
-- Enforce the canonical format. NULL is allowed (phone is optional at
-- the column level); non-null values must be exactly '+63' + a 10-digit
-- subscriber number starting with 9.
-- Guarded on pg_constraint so re-running on a DB that already has the
-- constraint is a no-op rather than a 42710 error.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_phone_ph_format_chk'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_phone_ph_format_chk
      check (phone is null or phone ~ '^\+639\d{9}$'); -- +63, then 9, then 9 more digits (10-digit subscriber)
  end if;
end $$;
