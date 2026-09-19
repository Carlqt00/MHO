# Paste-ready bundles for the Supabase Dashboard editor

Single-file copies of the SMS Edge Functions with the `_shared/*` modules
inlined, for deploying **without the CLI** (Dashboard → Edge Functions → editor
cannot resolve `../_shared` imports). Generated — do not edit by hand; edit the
real sources under `supabase/functions/<name>/` and regenerate. The CLI
(`supabase functions deploy <name>`) ignores this folder (leading underscore).

| Paste into function… | File | Verify JWT |
|---|---|---|
| `send-sms` | `send-sms.ts` | ON |
| `send-announcement-sms` (create new) | `send-announcement-sms.ts` | ON |
| `password-reset-request` | `password-reset-request.ts` | **OFF** |
| `password-reset-complete` | `password-reset-complete.ts` | **OFF** |
| `itextmo-webhook` | `itextmo-webhook.ts` | **OFF** |

Steps are in `docs/sms-deploy-runbook.md` (Dashboard section).
