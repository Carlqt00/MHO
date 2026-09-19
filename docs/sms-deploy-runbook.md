# SMS (iTextMo) — deploy runbook

For whoever has **owner/admin access to the Supabase project** (`mqjflphhgalcodtoxnaf`).
Takes ~10 minutes. Everything below is idempotent — safe to re-run.

## 0. Prerequisites

- Supabase CLI: `npm i -g supabase` (or use `npx supabase …`)
- Logged in: `supabase login` (opens the browser), then from the repo root:
  `supabase link --project-ref mqjflphhgalcodtoxnaf`
- The iTextMo API key. It is on the gateway phone: iTextMo app → **Settings →
  Authentication → Password** (starts with `sk_live_`). Do **not** paste it into
  any file that is committed.

## 1. Set the Edge Function secrets

```bash
supabase secrets set \
  ITEXTMO_API_KEY=sk_live_PASTE_FROM_PHONE \
  ITEXTMO_ENDPOINT=https://itextmo-backend-dev.vercel.app/api/v1/messages
supabase secrets list
```

Notes (verified 2026-09-19 against the live gateway):
- Auth is `Authorization: Bearer <key>`. The "Username"/device id shown on the
  phone is **not** used.
- The endpoint path **must** include `/api/v1/messages`. The phone's Settings
  screen shows only the host, and `itextmo-backend.vercel.app` (no `-dev`)
  redirects here.
- Optional later: `ITEXTMO_WEBHOOK_SECRET` (see step 4).

## 2. Apply the database migration

Either:

```bash
supabase db push            # applies supabase/migrations/0021_*.sql
```

or paste `supabase/migrations/0021_appointment_actions_and_sms.sql` into the
Dashboard → **SQL Editor** and run it (that's how earlier migrations were applied).

It adds: `reschedule_appointment`, `set_appointment_status`, an updated
`advance_queue` and `list_exception_appointments`, delivery-tracking columns on
`notification_logs`, `announcements.sms_sent_at`, and
`password_reset_requests.code_attempts`.

## 3. Deploy the functions

```bash
supabase functions deploy send-sms
supabase functions deploy send-announcement-sms
supabase functions deploy password-reset-request  --no-verify-jwt
supabase functions deploy password-reset-complete --no-verify-jwt
supabase functions deploy itextmo-webhook         --no-verify-jwt
```

`--no-verify-jwt` is required on the three public ones (forgot-password runs
before login; the webhook is called by iTextMo, which signs with HMAC instead).

## 4. Webhook — already configured, nothing to create

`GET /api/v1/device` on the gateway shows the webhook is set to
`https://mqjflphhgalcodtoxnaf.supabase.co/functions/v1/itextmo-webhook`
(events sent/delivered/failed/inbound, verified 2026-09-17), and that URL
answers the verify challenge. To enable signature checking, re-save the webhook
once from the phone (Settings → Delivery receipts → **Save & verify**), copy the
secret it shows, and:

```bash
supabase secrets set ITEXTMO_WEBHOOK_SECRET=PASTE
```

Until then the webhook accepts unsigned receipts and logs a warning.

## 5. Smoke test

1. Make sure the gateway phone is **on, charged, on the network**, and the
   iTextMo app shows "Accepting messages". (On 2026-09-19 the gateway reported
   `status: stale / device_unreachable` — the phone was off or killed by
   battery optimisation. Settings → Battery → Unrestricted.)
2. In the app as **admin**: Administrator → Notifications → *Send SMS
   Notification* → your own number → send. The row should appear as **Sent**,
   then flip to **Delivered** once the phone reports back (webhook).
3. As a **patient**: book an appointment → you get the confirmation text.
   Dashboard → **Ilipat ang oras** → pick a new slot → "moved to …" text.
4. As **staff**: Queue board → **Check in** (text) → **Call Next** ("it's your
   turn" text to that patient; "thank you" text to the one just finished).
5. **Forgot Password** → enter name/phone/email → 6-digit code arrives by SMS.
6. Administrator → Announcements → a published item → **Send via SMS** →
   confirm the recipient count.

If a send fails with `SMS service is not configured.` the secrets from step 1
are missing on the deployed function. If it fails with
`Gateway rejected the API key.` the key is wrong or was rotated on the phone.

## 6. Give the dev account access (so this isn't needed next time)

Dashboard → Organization → **Team** → Invite → the developer's email with the
*Developer* role. That is enough to set secrets and deploy functions.
