-- ============================================================
-- 0020_notification_logs.sql
-- Delivery log for outbound notification attempts.
--
-- The existing public.notifications table is for scheduled appointment
-- reminders/confirmations. This table is the operational audit trail used by
-- the Administrator > Notifications page and the send-sms Edge Function.
-- ============================================================

create table if not exists public.notification_logs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('sms', 'email')),
  recipient text not null,
  message text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  patient_id uuid references public.patients (id) on delete set null,
  appointment_id uuid references public.appointments (id) on delete set null,
  error_message text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_notification_logs_created_at
  on public.notification_logs (created_at desc);

create index if not exists idx_notification_logs_status
  on public.notification_logs (status);

create index if not exists idx_notification_logs_patient
  on public.notification_logs (patient_id);

create index if not exists idx_notification_logs_appointment
  on public.notification_logs (appointment_id);

alter table public.notification_logs enable row level security;

-- Admins can inspect all delivery attempts. Normal patient accounts do not get
-- a broad log view, and writes are intentionally left to service-role contexts
-- such as Edge Functions.
drop policy if exists "admin: select notification logs" on public.notification_logs;
create policy "admin: select notification logs"
  on public.notification_logs for select to authenticated
  using (public.is_admin());

grant select on public.notification_logs to authenticated;
