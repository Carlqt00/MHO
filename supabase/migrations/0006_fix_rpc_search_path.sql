-- ============================================================
-- 0006_fix_rpc_search_path.sql
-- Fix "function gen_random_bytes(integer) does not exist" when
-- calling book_appointment.
--
-- ROOT CAUSE: pgcrypto lives in the `extensions` schema on Supabase.
-- book_appointment pinned `set search_path = public`, which hides
-- that schema at runtime. (The qr_code column default worked because
-- table defaults bind the function at DDL time, not call time.)
--
-- Idempotent — safe to run on any database state. On a fresh setup
-- the corrected 0003 already sets this; these ALTERs are no-ops then.
-- ============================================================

-- Ensure pgcrypto exists in the extensions schema (no-op if present)
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

alter function public.book_appointment(uuid)
  set search_path = public, extensions;

alter function public.cancel_appointment(uuid)
  set search_path = public, extensions;
