-- ============================================================
-- 0016_provider_ticket_read.sql
-- Let a provider (doctor/nurse/dentist) read the queue_tickets of the
-- appointments assigned to THEM, and nothing else.
--
-- WHY: the Doctor appointment schedule shows each appointment's ticket
-- number. A doctor reads their own appointments via "provider: select own
-- appointments" (0002), patient name/phone via "provider: select profiles of
-- own patients" (0002), but queue_tickets had NO provider policy — only
-- "patient: select own tickets" and "nurse/staff/admin: select all tickets"
-- (0002). A doctor is none of those, so ticket_number came back null. This
-- adds the one missing, narrowly-scoped SELECT policy.
--
-- SCOPE / SECURITY: mirrors the patient ticket policy's shape but keys on
-- provider_id = my_provider_id() instead of patient_id. A provider sees a
-- ticket ONLY when its appointment is assigned to them — never another
-- provider's tickets, never the whole board. Read-only; no INSERT/UPDATE
-- (ticket writes still go through the booking RPC and staff/admin).
--
-- Idempotent: DROP POLICY IF EXISTS then CREATE (Postgres has no
-- CREATE POLICY IF NOT EXISTS), so this is safe to re-run.
-- APPLIED & VERIFIED 2026-08-21 — the "provider: select own appointment
-- tickets" policy exists on queue_tickets.
-- ============================================================

drop policy if exists "provider: select own appointment tickets" on public.queue_tickets;

create policy "provider: select own appointment tickets"
  on public.queue_tickets for select to authenticated
  using (
    appointment_id in (
      select id from public.appointments
      where provider_id = public.my_provider_id()
    )
  );
