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
