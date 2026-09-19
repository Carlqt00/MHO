-- ============================================================
-- 0022_sms_inbox.sql
-- Inbound SMS inbox for iTextMo message.inbound webhooks.
--
-- Outbound delivery attempts stay in public.notification_logs. This table is
-- only for SMS replies/messages received by the iTextMo Android device.
-- ============================================================

create table if not exists public.sms_inbox (
  id uuid primary key default gen_random_uuid(),
  provider_message_id text,
  sender text not null,
  message text not null,
  received_at timestamptz not null default now(),
  is_read boolean not null default false,
  raw_payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_sms_inbox_received_at
  on public.sms_inbox (received_at desc);

create index if not exists idx_sms_inbox_sender
  on public.sms_inbox (sender);

create index if not exists idx_sms_inbox_is_read
  on public.sms_inbox (is_read);

create unique index if not exists uniq_sms_inbox_provider_message_id
  on public.sms_inbox (provider_message_id)
  where provider_message_id is not null;

alter table public.sms_inbox enable row level security;

drop policy if exists "admin: select sms inbox" on public.sms_inbox;
create policy "admin: select sms inbox"
  on public.sms_inbox for select to authenticated
  using (public.is_admin());

drop policy if exists "admin: update sms inbox" on public.sms_inbox;
create policy "admin: update sms inbox"
  on public.sms_inbox for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on public.sms_inbox from anon;
revoke all on public.sms_inbox from authenticated;
grant select, update on public.sms_inbox to authenticated;
