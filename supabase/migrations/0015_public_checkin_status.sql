-- ============================================================
-- 0015_public_checkin_status.sql
-- Public (no-login) QR check-in STATUS lookup.
--
-- A patient scans their ticket QR on arrival; the QR opens
-- <origin>/checkin/<qr_code>, which needs to show that ONE ticket's queue
-- status to an ANONYMOUS visitor. The RLS policy "patient: select own
-- tickets" (0002) requires an authenticated patient, so anon cannot read
-- queue_tickets directly. This SECURITY DEFINER function is the only anon
-- read path, and it is deliberately minimal.
--
-- SECURITY — what this function must and must NOT expose:
--   * Returns ONLY: ticket_number, queue_position, ticket status, service
--     name, provider name, and the appointment's slot_datetime.
--   * NEVER returns patient name / email / phone / patient_id, the appointment
--     id, the qr_code, or ANY other ticket. Someone holding a leaked code
--     learns nothing beyond that single ticket's queue status.
--   * Looks up by qr_code, which is UNIQUE (0001) → at most one row. An unknown
--     code returns ZERO rows (the page renders a plain "not found"); it never
--     signals whether the code was "close", so nothing is leaked by probing.
--
-- READ ONLY: this function changes no state. It does NOT check the patient in —
-- staff still process check-in at reception. The page says so.
--
-- Conventions: language sql, STABLE, SECURITY DEFINER, pinned search_path,
-- execute granted to anon + authenticated. Idempotent via CREATE OR REPLACE.
-- APPLIED & VERIFIED 2026-08-21 — checkin_status exists with EXECUTE granted
-- to both anon and authenticated.
-- ============================================================

create or replace function public.checkin_status(p_code text)
returns table (
  ticket_number  text,
  queue_position integer,
  status         text,
  service_name   text,
  provider_name  text,
  slot_datetime  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    qt.ticket_number,
    qt.queue_position,
    qt.status,
    s.name          as service_name,
    prof.full_name  as provider_name,
    ts.slot_datetime
  from public.queue_tickets qt
  join public.appointments a  on a.id = qt.appointment_id
  join public.services s      on s.id = a.service_id
  join public.providers pv    on pv.id = a.provider_id
  join public.profiles prof   on prof.id = pv.profile_id
  join public.time_slots ts   on ts.id = a.slot_id
  where qt.qr_code = p_code;
$$;

-- Anon (the scanning visitor) and authenticated (a logged-in patient hitting
-- the same URL) may both call it. The function's projection is the security
-- boundary — not RLS — so this grant is safe.
grant execute on function public.checkin_status(text) to anon, authenticated;
