-- ============================================================
-- 0040_drop_obsolete_reschedule_proposal_overload.sql
-- Retire the pre-response-code admin_create_reschedule_proposal overload.
-- The current Edge Function uses the 7-argument version introduced by
-- 0034 and repaired by 0039.
-- ============================================================

drop function if exists public.admin_create_reschedule_proposal(
  uuid,
  uuid,
  text,
  text,
  timestamptz
);
