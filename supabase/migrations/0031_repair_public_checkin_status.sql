-- ============================================================
-- 0031_repair_public_checkin_status.sql
-- Targeted repair for production projects missing the public QR status RPC.
--
-- This intentionally recreates only public.checkin_status(p_code text), the
-- minimal read-only SECURITY DEFINER function used by /checkin/:code.
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

grant execute on function public.checkin_status(text) to anon, authenticated;

notify pgrst, 'reload schema';
