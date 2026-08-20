# Supabase database files

**Status: NOT YET APPLIED — no Supabase project exists yet.**

| File | What it does |
|---|---|
| `migrations/0001_initial_schema.sql` | Tables (project_context.md §5), indexes, new-user trigger |
| `migrations/0002_rls_policies.sql` | RLS helper functions + per-role policies (RBAC §4) |
| `seed.sql` | Real MHO staffing (§7): 3 doctors, 1 dentist, 5 nurses, staff, admin, 3 demo patients, services, facility-hours availability |

## How to apply (when the Supabase account is ready)

**Option A — Supabase CLI (recommended, local dev first):**
```bash
supabase init          # if not yet linked
supabase start         # local stack
supabase db reset      # runs migrations + seed.sql automatically
```

**Option B — hosted project, SQL Editor:**
Run in order: `0001_initial_schema.sql` → `0002_rls_policies.sql` → `seed.sql`.

## Notes

- All seed accounts use password `demo1234`; emails match the Step 1 mock
  users (`patient@demo.mho`, `doctor@demo.mho`, …) so the auth swap keeps
  the same demo logins.
- `seed.sql` inserts into `auth.users` directly — fine for local/dev.
  On a production instance create users via the dashboard/admin API instead.
- Booking / cancel / queue-advance writes are intentionally NOT allowed
  through RLS — they will be SECURITY DEFINER RPCs in Step 3 (race-safe).
