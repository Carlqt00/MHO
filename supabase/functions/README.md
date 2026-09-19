# Admin Edge Functions

Server-side, admin-only operations that need the **service-role key** (which
must never reach the browser):

| Function | Purpose |
|---|---|
| `admin-create-user` | Create a staff / doctor / nurse / admin account with the correct `app_metadata.role` (+ `providers` row for doctor/nurse). |
| `admin-update-role` | Change an existing user's role in both `app_metadata` and `profiles.role`. |
| `_shared/admin.ts` | `requireAdmin(req)` — the single security gate both functions call. |

## Why these are server-side

`app_metadata.role` can only be written with the service-role key. The
`handle_new_user` trigger reads it to stamp `profiles.role`, so self-signup is
always `patient`. Setting a real role therefore requires a trusted server path.

## Environment variables

Both functions rely **only** on the three secrets Supabase **auto-injects** into
every deployed Edge Function — you do **not** set these yourself:

| Var | Injected by | Used for |
|---|---|---|
| `SUPABASE_URL` | platform | building the two clients |
| `SUPABASE_ANON_KEY` | platform | verifying the caller's JWT (`getUser`) |
| `SUPABASE_SERVICE_ROLE_KEY` | platform | privileged writes after admin check |

> The service-role key lives **only** in the function runtime. It is never in
> `.env`, never in `VITE_*`, never returned in a response or error. No manual
> `supabase secrets set` is required for these functions.

The browser needs no new env vars: `supabase.functions.invoke()` reuses the
existing `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` client and automatically
attaches the signed-in admin's JWT as the `Authorization` header.

## Deploy

```bash
supabase functions deploy admin-create-user
supabase functions deploy admin-update-role
```

Keep JWT verification **on** (the default). It is a first gate at the gateway,
but it only proves *some* valid user is calling — the admin check inside
`requireAdmin` is what actually authorizes. Do **not** deploy with
`--no-verify-jwt`.

## Test locally

1. Start the local stack (injects the three secrets automatically):
   ```bash
   supabase start
   supabase functions serve
   ```
2. Get an **admin** access token — sign in through the app as an admin and copy
   `access_token` from the session, or via CLI:
   ```bash
   curl -s "$SUPABASE_URL/auth/v1/token?grant_type=password" \
     -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
     -d '{"email":"admin@demo.mho","password":"demo1234"}' | jq -r .access_token
   ```
3. Call the function with that token:
   ```bash
   curl -i -X POST "http://127.0.0.1:54321/functions/v1/admin-create-user" \
     -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"email":"dr.reyes@example.com","fullName":"Dr. Reyes","role":"doctor","providerType":"doctor","specialization":"Pediatrics"}'
   ```

### Negative tests (must all be rejected)

| Token | Expected |
|---|---|
| none / missing header | `401 Missing authorization token.` |
| a **patient** or **staff** token | `403 Administrator access required.` |
| admin token, `admin-update-role` targeting **your own** id | `403 You cannot change your own role.` |
| garbage / expired token | `401 Invalid or expired session.` |

## Not implemented: deactivate / reactivate

The schema has **no** deactivation flag on `profiles` (the only `active` column
is on `services`). Rather than invent one, this is deferred. To add it, either:

- **Add a column** — `alter table public.profiles add column active boolean not null default true;`
  then filter logins/listings on it and gate changes behind `is_admin()`. Easiest
  because the users table already reads from `profiles`. **Recommended.**
- **Use Supabase Auth bans** — `admin.updateUserById(id, { ban_duration })` blocks
  login without a schema change, but `profiles` won't reflect status, so the table
  couldn't show active/inactive without an extra Auth admin lookup.

Either way, the same self-protection applies: an admin must not be able to
deactivate their own account (enforce server-side like the role guard).

---

# SMS Edge Functions (iTextMo)

All patient texts go through one gateway: **iTextMo**
(<https://itextmo.netlify.app/documentation>) — an Android handset with the
clinic SIM that drains an API queue at ~1 msg/sec. Every send is recorded in
`public.notification_logs` (Administrator → Notifications).

| Function | Auth | Purpose |
|---|---|---|
| `_shared/sms.ts` | — | `sendSms()` — writes the log row, calls `POST /v1/messages`, stores the gateway message id, flips the row to `sent`/`failed`. Used by every function below. |
| `send-sms` | user JWT | Appointment lifecycle texts (`appointment_booked`, `appointment_cancelled`, `appointment_rescheduled`, `appointment_checked_in`, `appointment_served`, `appointment_no_show`, `queue_now_serving`) — message text is composed server-side from the appointment row. Patients may trigger booked/cancelled/rescheduled for their own appointment; nurse/staff/admin may trigger all. Also the admin free-text send (`{recipient, message}`). |
| `send-announcement-sms` | admin JWT | Broadcast one **published** announcement to every patient with a `+639…` number. Explicit admin action with a recipient count. Resumable: patients already `sent`/`delivered` for that announcement are skipped. |
| `password-reset-request` | public | Verifies name + email + phone, then texts a 6-digit code (15 min TTL, 60 s resend cooldown). The code is never returned to the browser. |
| `password-reset-complete` | public | `{requestId, code, newPassword}` — 5 wrong codes void the request. |
| `itextmo-webhook` | HMAC | Delivery receipts: `message.sent` / `message.delivered` / `message.failed` update the matching log row (by gateway id, falling back to `client_ref` = our log id). Answers the `webhook.verify` challenge. |

## Secrets (`supabase secrets set …`)

| Secret | Required | Notes |
|---|---|---|
| `ITEXTMO_API_KEY` | yes | The `sk_live_…` key — on the handset under Settings → Authentication → Password (the "Username"/device id is NOT needed; auth is `Authorization: Bearer <key>`). Rotate rather than re-pair. |
| `ITEXTMO_ENDPOINT` | **yes for us** | Defaults to `https://api.itextmo.com/v1/messages`, but our handset is paired to a per-device backend: `https://itextmo-backend-dev.vercel.app/api/v1/messages` (note the `/api/v1` prefix; the phone's Settings screen shows only the host, and the non-`-dev` host 307-redirects here). Same contract: Bearer key, `Idempotency-Key` required, unknown body fields rejected. |
| `ITEXTMO_WEBHOOK_SECRET` | strongly recommended | Returned when the webhook URL is saved. Without it the webhook accepts unsigned receipts (logged as a warning). |

```bash
supabase secrets set ITEXTMO_API_KEY=sk_live_… ITEXTMO_ENDPOINT=https://itextmo-backend-dev.vercel.app/api/v1/messages
supabase secrets list   # shows names + digests only, never values
```

Local `.env` holds the same values as `ITEXTMO_BACKEND_URL` / `ITEXTMO_USERNAME` /
`ITEXTMO_PASSWORD` for probing the gateway from a shell (`.env` is gitignored;
the browser never reads these — only `VITE_*` vars are exposed).

Verified 2026-09-19 with those credentials: `GET …/api/v1/device` shows the
webhook already configured (`…/functions/v1/itextmo-webhook`, sent/delivered/
failed/inbound, verified 2026-09-17) and `GET …/api/v1/messages` lists history.

Without `ITEXTMO_API_KEY` every send fails with `SMS service is not configured.`
and is logged as `failed` — the appointment action itself still succeeds; the UI
shows a "…but the SMS notification could not be sent" warning.

## Deploy

```bash
supabase functions deploy send-sms
supabase functions deploy send-announcement-sms
supabase functions deploy password-reset-request --no-verify-jwt   # public
supabase functions deploy password-reset-complete --no-verify-jwt  # public
supabase functions deploy itextmo-webhook --no-verify-jwt          # called by iTextMo, HMAC-signed
```

Then in the iTextMo app (Settings → Webhooks) or via `PUT /v1/webhook`, set the
URL to `https://<project-ref>.supabase.co/functions/v1/itextmo-webhook` with
`sent`, `delivered`, `failed` enabled, and store the returned secret as
`ITEXTMO_WEBHOOK_SECRET`. `POST /v1/webhook/test` fires a signed `message.sent`
to confirm the signature check.

## Gateway limits worth knowing

- 1 msg/sec per SIM, 1000-message queue, 2000/day quota, 5 msgs per recipient
  per 10 min (20/day). An announcement to 1000+ patients takes ~17 minutes to
  drain and may need a second "Send via SMS" click to finish.
- A reply containing STOP/TIGIL blocklists that number; later sends fail with
  `RECIPIENT_BLOCKED` (shown in the log's error column).
- Gateway history is deleted after 7 days — `notification_logs` is the record.
