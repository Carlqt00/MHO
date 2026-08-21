# project_context.md — MHO Centralized Appointment & Ticketing System

> **Detailed project memory.** Referenced by `CLAUDE.md`, which Claude Code auto-loads every session. Update this file as the build progresses. Capstone by John Carlo Montales + Ronian Rañola for the Daraga Municipal Health Office, Albay.

---

## 1. Project Snapshot

- **System:** Web-based Centralized Appointment & Ticketing System
- **Client:** Daraga Rural Health Unit (MHO), San Roque, Daraga, Albay
- **Authors:** John Carlo Montales, Ronian Rañola (BSIT, CATC)
- **Methodology:** Agile (Plan → Design → Develop → Test → Deploy → Review → Launch)
- **Evaluation:** ISO 25010
- **Build approach:** Solo dev (Kin assisting), small flows first. Model: Sonnet 4.6 daily / Opus 4.8 for hard decisions / Fable 5 for long-horizon tasks when available.

---

## 2. Tech Stack (decided)

- **Frontend:** React + TypeScript + Vite
- **Styling:** Tailwind CSS v4
- **Backend / DB / Auth / Realtime:** Supabase (PostgreSQL)
- **Hosting:** Vercel (frontend) + Supabase (backend)
- **SMS:** TBD provider (Semaphore for PH, or Twilio) — mock/log fallback for demo
- **PDF export:** jsPDF + jspdf-autotable
- **Excel export:** SheetJS (xlsx)

> Familiar stack para mabilis — same as Buildease ERP at BantayBarangay.

---

## 3. Scope Guardrails (STRICT — from approved manuscript)

### ✅ IN SCOPE — build these
1. Appointment Scheduling — book / reschedule / cancel + real-time availability
2. Ticketing & Queue Management — auto queue numbers, live "now serving", QR check-in
3. Patient Records — appointment-scoped only (profile + appointment history)
4. Provider Availability — doctors/nurses set availability + time-slot allocation
5. Notifications — SMS + email reminders (24h before), confirmations
6. Announcements — MHO posts advisories
7. Reports — daily/weekly/monthly summaries, patient stats; export PDF + Excel

### ❌ OUT OF SCOPE — NEVER build (delimited in manuscript)
- Electronic Medical Records (EMR) / clinical / medical data
- Billing, payments, insurance processing
- Telemedicine / online consultation / online diagnosis
- Emergency / real-time treatment handling
- Multi-facility (single-facility Daraga MHO only)

> Kapag may feature na lumalampas dito, FLAG IT. Mismatch sa paper = defense risk.

---

## 4. Roles & Access (RBAC)

| Role | Can do |
|---|---|
| **Patient** | Register/login, view availability, book/reschedule/cancel, get queue ticket, QR check-in, view own history, receive reminders |
| **Doctor** | View assigned schedule, set/manage own availability |
| **Nurse** | View schedule, manage availability, assist patient flow |
| **Healthcare Staff** | Manage appointment-scoped patient records, update appointment details, advance queue |
| **Administrator** | Full control: users/roles, schedules, announcements, reports, system settings |

> RLS enforced: a patient must NEVER see another patient's data.

---

## 5. Suggested Initial Schema

> **Implemented:** see `supabase/migrations/0001_initial_schema.sql` (tables + indexes + new-user trigger) and `0002_rls_policies.sql` (RLS). Seed data sa `supabase/seed.sql`. The SQL files are the source of truth now; the sketch below is the original starting point. Appointment-scoped, walang clinical fields.
>
> **Migration history:** `0001` schema · `0002` RLS · `0003` booking RPC · `0004` test slots (dev-seed) · `0005` repair seeded auth users · `0006` fix RPC search_path · `0007` queue board · `0008` provider time-off + slot gen · `0009` exception slot enforcement · `0010` **phone normalization** — normalizes existing `profiles.phone` to canonical `+639XXXXXXXXX` and adds the `profiles_phone_ph_format_chk` CHECK constraint enforcing that format. Applied directly; all 19 existing rows verified canonical, zero nulls. · `0011` **booking conflict guards** — adds stored `appointments.appointment_at` (timestamptz) + `appointment_date` (Manila date, RPC-populated), two partial unique indexes (`uniq_active_service_per_patient_day`, `uniq_active_time_per_patient`, both `WHERE status <> 'cancelled'`), updates `book_appointment` to populate the new columns, and adds the `service_daily_availability(service, from, to)` aggregate RPC for the month calendar. Idempotent. **Applied & verified 2026-08-21** — `appointments.appointment_at` + `appointment_date` columns exist, both partial unique indexes (`uniq_active_service_per_patient_day`, `uniq_active_time_per_patient`) exist, and `service_daily_availability` exists. · `0012` **appointment volume analytics** — four SECURITY INVOKER aggregate RPCs (`appointment_volume_by_day/week/month/year(p_from, p_to)`) returning per-period status counts (attended / no_show / cancelled / pending / total) grouped by `appointments.appointment_date`, backing the admin Overview patient-volume chart. Follows the `service_daily_availability` pattern (`stable`, `security invoker`, `search_path = public`, granted to `authenticated`); admin RLS `staff/admin: select all appointments` gives true totals. Idempotent (`CREATE OR REPLACE`). **Applied & verified 2026-08-20** — all four RPCs exist with `has_function_privilege(..., 'EXECUTE') = true` for `authenticated`. · `0013` **service daily slot status** — `service_daily_slot_status(service, from, to)` returns per-Manila-day `remaining` / `unbooked` / `upcoming` / `total` slot counts (SECURITY INVOKER, excludes exception-date slots, keeps the `slot_datetime >= now()` filter on `remaining`). Lets the patient calendar tell "Walang schedule" (no slots) / "Puno" (all booked) / "Lipas na" (open but times passed) apart instead of labelling all three "Puno". Supersedes the open-count-only `service_daily_availability` (`0011`) for the calendar; that function is left in place. Idempotent. **Applied & verified 2026-08-20** — `service_daily_slot_status` exists with `has_function_privilege(..., 'EXECUTE') = true` for `authenticated`. · (no `0014` — the patient profile page needed no migration; the existing `patient: select own …` policies already scope a patient to their own profile, appointments, and tickets) · `0015` **public QR check-in status** — `checkin_status(p_code text)` SECURITY DEFINER RPC returning ONLY `ticket_number` / `queue_position` / ticket `status` / service name / provider name / `slot_datetime` for the single ticket matched by its UNIQUE `qr_code`. Deliberately exposes nothing else: never the patient name/email/phone/`patient_id`, the appointment id, the `qr_code`, or any other ticket, so a leaked code reveals nothing beyond that one ticket's queue status; an unknown code returns zero rows. Backs the public, no-login `/checkin/:code` status page (anon cannot select `queue_tickets` under RLS, so this definer RPC is the only anon read path). Idempotent (`CREATE OR REPLACE`); execute granted to `anon` + `authenticated`. **Applied & verified 2026-08-21** — `checkin_status` exists with `EXECUTE` granted to both `anon` and `authenticated`.

```
-- Roles handled via Supabase auth + a profile role column (or app_metadata)

profiles
  id (uuid, = auth.users.id)
  full_name
  role          -- 'patient' | 'doctor' | 'nurse' | 'staff' | 'admin'
  phone
  email
  created_at

patients          -- extra patient-only info (appointment-scoped)
  id (uuid)
  profile_id (fk -> profiles)
  birthdate
  address
  created_at

providers          -- doctors / nurses / dentist
  id (uuid)
  profile_id (fk -> profiles)
  provider_type   -- 'doctor' | 'nurse' | 'dentist'
  specialization  -- nullable
  created_at

services
  id (uuid)
  name            -- 'Immunization' | 'Prenatal' | 'General Check-up' | 'Dental'
  description
  active (bool)

provider_availability
  id (uuid)
  provider_id (fk -> providers)
  day_of_week     -- or specific date
  start_time
  end_time
  created_at

time_slots         -- generated bookable slots
  id (uuid)
  provider_id (fk -> providers)
  service_id (fk -> services)
  slot_datetime
  is_booked (bool)

appointments
  id (uuid)
  patient_id (fk -> patients)
  provider_id (fk -> providers)
  service_id (fk -> services)
  slot_id (fk -> time_slots)
  status          -- 'booked' | 'checked_in' | 'served' | 'cancelled' | 'no_show'
  booked_at
  created_at

queue_tickets
  id (uuid)
  appointment_id (fk -> appointments)
  ticket_number
  queue_position
  status          -- 'waiting' | 'now_serving' | 'done'
  qr_code         -- token for check-in
  created_at

announcements
  id (uuid)
  posted_by (fk -> profiles)
  title
  body
  published (bool)
  created_at

notifications
  id (uuid)
  appointment_id (fk -> appointments)
  type            -- 'sms' | 'email'
  purpose         -- 'confirmation' | 'reminder'
  status          -- 'pending' | 'sent' | 'failed' | 'mocked'
  scheduled_for
  sent_at

audit_log
  id (uuid)
  actor_id (fk -> profiles)
  action
  target_table
  target_id
  created_at
```

---

## 6. Critical Logic Notes

- **Race-safe booking (CRITICAL):** Two patients must never book the same slot. Use a DB-level lock / transaction (atomic check-and-set on `time_slots.is_booked`, o `SELECT ... FOR UPDATE` sa isang RPC). Same principle ng GV numbering at stock-withdrawal fixes sa Buildease.
- **Realtime queue:** Use Supabase realtime as signal-only — trigger a refresh, huwag mag-render directly from payload (same pattern na ginawa sa BantayBarangay para iwas RLS leak).
- **Connectivity-resilient:** Preserve form input on dropped connection. HINDI full offline — graceful failure lang.

---

## 7. Real Seed Data (use these — match manuscript Table 1 & 2)

- **Staff:** 3 doctors, 1 dentist, 5 nurses
- **Hours:** Mon–Fri 8AM–4PM | Sat 8AM–3PM | Sun 8AM–11AM
- **Services:** Immunization, Prenatal, General Check-up, Dental
- Add a few demo patients for testing

---

## 8. Build Order (small flows first)

- [x] **Step 0:** Scaffold (Vite + React + TS) + Supabase connected + lint/format
- [x] **Step 1:** Auth — UI shell done, MOCK auth only, Supabase swap pending. All auth logic isolated in `src/lib/auth.ts` (see TODO(supabase-swap) comment there). Demo users: one per role, password `demo1234`.
- [x] **Step 2:** Core schema + RLS + seed data — APPLIED and verified. Migrations and seed ran successfully. RLS confirmed: patient sees only own row, direct ID lookup by another patient returns 0 rows, admin sees all 3 patients.
- [x] **Step 3:** ONE booking flow end-to-end — patient books → gets queue ticket. Supabase auth swap done. book_appointment RPC (race-safe, SELECT FOR UPDATE). **Booking UI is now 4-step (2026-08-18): Service → Date → Time → Confirm.** The old step-2 time list was replaced with a month-view calendar (current month +2): each day cell shows remaining-slot count for the service, zero/past days disabled (non-color signal — line-through + “—”/“Puno”), one aggregate query per month via `service_daily_availability`. Two per-patient booking guards added (`0011`, see decisions log) with client-side pre-checks mirroring them. VERIFIED end-to-end (ticket T001 issued). **Race-safety PROVEN 2026-07-10:** `scripts/race-test.mjs` fired 10 concurrent book_appointment calls on one slot → exactly 1 success, 9 clean ERR_ALREADY_BOOKED rejections, DB count confirmed 1 active appointment. Rerunnable anytime: `node scripts/race-test.mjs` (cleans up after itself).
- [x] **Step 4:** Live queue board (staff side, realtime) — QueueBoard component on /staff and /nurse, grouped per provider, "Done, Call Next" via atomic advance_queue RPC (advisory lock). Realtime = signal-only refetch on queue_tickets changes. ⚠ Apply `0007_queue_board.sql` first (nurse read policies + RPC + realtime publication). Realtime sync across devices pending user verification.
- [x] **Step 4.5:** Admin shell + user & role management — DONE. Nested `/admin` layout (`AdminLayout` + sidebar) with an overview page (live stat cards: patients, providers, appointments today, tickets waiting) and section routes. User & Role Management page: searchable/role-filtered `profiles` table, add-user form, inline role change with a confirm step, self-demote guard (UI + server). Two Edge Functions in `supabase/functions/`: `admin-create-user` (service-role creates the auth user with server-only `app_metadata.role` + a `providers` row for doctor/nurse) and `admin-update-role` (updates `app_metadata` + `profiles.role`, blocks self-change). Both go through `requireAdmin()` — verifies the JWT via GoTrue, then checks the LIVE `profiles.role`. Deactivate deferred (no `active` column yet — see `supabase/functions/README.md`). Applied & tested.
- [x] **Step 5:** Provider availability & time-slot management — DONE. `/admin/providers`: per-provider weekly availability editor, exception dates (`provider_time_off`: NULL provider = clinic-wide holiday, set = personal leave), and a slot generator with preview→commit. `generate_time_slots(...)` RPC (`0008`): idempotent (`ON CONFLICT DO NOTHING`), configurable interval, insert-only so booked slots are never touched, internal `is_admin()` guard. Exception enforcement (`0009`): the `is_exception_slot` predicate is shared by the `open_slots` read view and the `book_appointment` guard; unbooked slots on excepted dates are **hidden, not deleted**; adding an exception surfaces affected booked appointments for manual cancel/reschedule. **Applied & verified 2026-08-16** — `0008` + `0009` were written up 2026-08-15 but the whole batch had NOT actually been run until today; both are now live on the DB and the test list passes.
- [~] **Step 6:** Announcements + notifications — **announcements DONE**, notifications remaining.
  - ✅ **Announcements (DONE, client-only, no migration):** `/admin/announcements` full CRUD — list newest-first with Published/Draft badges, create/edit form (plain-text title + body, newlines preserved, no rich-text dep), publish/unpublish, delete-with-confirm. `AnnouncementsFeed` component (public feed of published rows, `published=true` filtered + graceful empty state) rendered on **all five role dashboards** (patient, doctor, nurse, staff — admin overview not required). API in `api.ts`: `fetchAllAnnouncements`/`fetchPublishedAnnouncements`/`create`/`update`/`setAnnouncementPublished`/`delete`. Table + RLS already existed (`0001`/`0002`).
  - 🔨 **Registration validation (IN PROGRESS NOW):** email format (type="email" + explicit regex, inline notice on blur, trim+lowercase before submit) and PH phone (static `+63` prefix, digits-only max-10 starting with 9, paste-format normalization, live 10/10 counter). Canonical `+639XXXXXXXXX` assembled client-side at submit; the DB `profiles_phone_ph_format_chk` CHECK (migration `0010`) is the real enforcement, surfaced via a constraint-name mapping in `errors.ts`. Client validation is UX only.
  - ⬜ **Notifications (REMAINING — NEXT after registration validation):** mock SMS + email (24h reminders + confirmations). `notifications` table already exists (`0001`); no client code yet. Build the Admin surface first (notification log at `/admin/notifications`), mock/log provider fallback for the demo. The canonical `+639XXXXXXXXX` phone format is a prerequisite here — mock SMS will read `profiles.phone` as-is.
- [ ] **Step 7:** Reports + PDF/Excel export
  - 🔨 **Descriptive analytics — patient-volume chart (DONE, 2026-08-20):** Admin Overview (`/admin`) has a stacked patient-volume chart below the stat cards. One bar per period, height = total demand (all appointments with an `appointment_date` in that period), segments bottom→top = Attended (`checked_in`/`served`) / No-show (`no_show`) / Cancelled (`cancelled`) / Pending (`booked`). Granularity toggle Day (30d) / Week (12w) / Month (12mo) / Year (5y); empty periods render as zero-height bars, not gaps. No-show rate and cancellation rate for the visible range are shown below the chart; a note surfaces how many past-dated rows are still `booked` (never auto-reclassified — see decisions log). **Plain CSS/flex bars, no charting dependency** (solid colour is the primary signal, subtle pattern + legend + in-bar numbers are the non-color signals). Snapshot with a manual **Refresh** button + "last updated" time — **no realtime** (reserved for Live Queue). One aggregate RPC per granularity (`0012`); pure date/bucket math in `src/lib/volume.ts`, verified by `scripts/volume-buckets-test.mjs` (Node 24 type-stripping, no new dep). Aggregation only — no forecasting.
- [ ] **Step 8:** Hardening (validation, security, accessibility) + ISO 25010 notes — **includes the planned full UI/UX design pass across ALL dashboards** (see Design note below).
- [ ] **Step 9:** Deploy + README + Tagalog staff guide + traceability sheet

> Goal: pagkatapos ng Step 3, may maipapakita ka na sa kanila.
>
> **Sequencing note (2026-08-15):** now building role-by-role — **Admin end-to-end first, then Doctor.** Steps 5, 6, and 7 are each approached from the Admin surface first. **Reschedule appointment** remains its own dedicated upcoming feature — it is NOT part of the exception-date flow (that flow only offers Cancel), to avoid two divergent reschedule paths.
>
> **Status (2026-08-16):** **Admin role is nearly complete** — shell + overview, users/roles, providers/slots, and announcements are DONE; **notifications and reports remain**. After the Admin surface is finished, the **Doctor role is next**.
>
> **Design note (2026-08-16):** Every dashboard is intentionally **plain and unstyled right now** — this is by design. A single **full UI/UX design pass across ALL dashboards** is planned as a late phase, **overlapping Step 8** (hardening/accessibility). **Do NOT style page-by-page in the meantime** — polish happens once, holistically, so the whole app is consistent.

---

## 9. Decisions Log (update as you go)

| Date | Decision | Reason |
|---|---|---|
| 2026-07-09 | Tailwind CSS v4 (via @tailwindcss/vite) | No config file needed, same familiar stack as past projects |
| 2026-07-09 | ESLint (flat config) + Prettier | Template shipped oxlint; swapped to ESLint per project requirement |
| 2026-07-09 | oxlint removed | Replaced by ESLint to match stated toolchain |
| 2026-07-09 | react-router-dom v7 for routing | Standard React SPA router; role-guarded routes via `ProtectedRoute` |
| 2026-07-09 | Step 1 uses MOCK auth (no Supabase) | Supabase account not decided yet; all auth behind `src/lib/auth.ts` + `useAuth` hook so only that module changes on swap |
| 2026-07-09 | Mock session persisted in localStorage | Survives refresh like a real session would; key `mho.mock.session` |
| 2026-07-09 | Register page = patient role only | Staff/doctor/nurse/admin accounts will be admin-created, never self-registered |
| 2026-07-10 | text + CHECK constraints instead of Postgres enums | Easier to alter as scope evolves; same integrity |
| 2026-07-10 | Role stored in `profiles.role`, sourced from `raw_app_meta_data` on signup | app_metadata is server-only → self-signup can never claim staff/admin (privilege escalation blocked) |
| 2026-07-10 | Trigger `on_auth_user_created` auto-creates profile + patient row | Registration flow needs zero client-side table writes |
| 2026-07-10 | Partial unique index on `appointments(slot_id) where status <> 'cancelled'` | DB-level double-booking guard #2 (RPC lock is #1); cancelled slots stay rebookable |
| 2026-07-10 | No RLS insert policies for appointments/queue_tickets/time_slots writes | Booking, cancel, queue advance go through SECURITY DEFINER RPCs (Step 3) para race-safe |
| 2026-07-10 | RLS helpers are SECURITY DEFINER functions (`my_role()`, `my_patient_id()`, …) | Avoids recursive policy evaluation; single place to audit |
| 2026-07-10 | `day_of_week`: 0 = Sunday … 6 = Saturday | Matches Postgres EXTRACT(DOW) — no off-by-one when generating slots |
| 2026-07-10 | Dentist login = `profiles.role` 'doctor', `provider_type` 'dentist' | RBAC has no separate dentist role; provider_type carries the distinction |
| 2026-07-10 | Auth swap: mock → Supabase. Only `src/lib/auth.ts` changed | onAuthStateChange in AuthProvider; loading state in ProtectedRoute prevents redirect flash |
| 2026-07-10 | `book_appointment` RPC: SECURITY DEFINER + SELECT FOR UPDATE | No client insert policy on appointments/queue_tickets — only this function can write |
| 2026-07-10 | Queue position scoped to provider + calendar day (Asia/Manila) | Ticket numbers reset per day per provider |
| 2026-07-10 | `cancel_appointment` frees the slot (is_booked = false) | Cancelled slots become rebookable; partial unique index allows this |
| 2026-07-10 | Test slots: 30-min intervals, Mon–Fri 8–16, Sat 8–15, next 14 days | Generated by 0004_test_slots.sql; re-run weekly or build a slot-gen UI in Step 5 |
| 2026-07-10 | RPC search_path = `public, extensions` (0006) | pgcrypto lives in `extensions` schema on Supabase; a pinned `public`-only search_path hid gen_random_bytes at runtime. Rule: any SECURITY DEFINER function calling pgcrypto needs `extensions` in its search_path |
| 2026-07-10 | Race-safety proof kept as `scripts/race-test.mjs` | 10 concurrent RPCs → 1 win, 9 clean rejections. Rerun before the defense demo as evidence; also cite the two DB guard layers (FOR UPDATE lock + partial unique index) |
| 2026-07-10 | Nurse gets SELECT-all on appointments/patients/profiles (0007) | Queue board joins need it; nurses "assist patient flow" per RBAC. Writes stay staff/admin + RPCs |
| 2026-07-10 | advance_queue allows nurse + staff + admin | Per Step 4 spec; direct table UPDATE stays staff/admin-only — nurse advance goes through the RPC |
| 2026-07-10 | advance_queue uses pg_advisory_xact_lock per provider | Two staff clicking "call next" simultaneously can't double-advance |
| 2026-07-10 | Realtime = signal-only (refetch on event, never render payload) | Same as BantayBarangay — payload bypasses the RLS-checked query shape |
| 2026-07-10 | cancel_appointment now closes the queue ticket | Step 3 gap: cancelled bookings left a ghost 'waiting' ticket on the board |
| 2026-07-10 | registerPatient builds Session directly from signUp — no profile read-back | Trigger is transactional so read-back is redundant; also removes the "Cannot coerce" failure path. Duplicate emails detected via explicit error OR anti-enumeration fake user (identities: []) |
| 2026-07-10 | "Confirm email" MUST stay OFF in Supabase Auth settings | Registration flow requires an immediate session (no email verification in scope). Verified ON caused the registration failures — turn it off and keep it off |
| 2026-07-10 | GoTrue rejects fake TLDs (like @demo.mho) for NEW signups | Seeded users bypass it via SQL insert; real registrations need real email domains. Registration test uses @gmail.com |
| 2026-08-15 | Inserted Step 4.5 (admin shell + user/role mgmt) before Step 5; sequencing role-by-role | Admin-created accounts are a hard prerequisite for Doctor/Nurse/Staff — self-signup is always 'patient' and role lives in server-only `raw_app_meta_data`, so every non-patient test account otherwise needs manual SQL. Build Admin end-to-end first (then Doctor); Steps 5–7 approached from the Admin surface first. Existing steps not renumbered. |
| 2026-08-15 | Admin-only writes that set `app_metadata.role` go through Edge Functions, not the client | `app_metadata.role` can only be set with the service-role key (never in the browser). `admin-create-user` / `admin-update-role` verify the caller via `requireAdmin()` (JWT → live `profiles.role`), then use the service role. Role change updates BOTH `app_metadata` (future JWTs) and `profiles.role` (RLS `my_role()`), since the on_auth_user_created trigger fires on INSERT only. |
| 2026-08-15 | SECURITY DEFINER functions MUST carry an internal `is_admin()` (or equivalent) guard | SECURITY DEFINER runs as the owner and **BYPASSES RLS** — a table's `admin: manage` policy does NOT protect the function. `generate_time_slots` and `list_exception_appointments` check `is_admin()` as their first statement (raise `ERR_FORBIDDEN`); EXECUTE granted to `authenticated` only. `auth.uid()` inside a definer function still resolves to the caller, so the check is correct. |
| 2026-08-15 | Exception dates HIDE unbooked slots — never auto-delete | `provider_time_off` stays the single source of truth. Removing an exception makes slots bookable again with zero regeneration, and nothing can ever clobber a booked slot. Deletion would be destructive + irreversible. A manual "purge unbooked" could be added later as opt-in, not automatic. |
| 2026-08-15 | Exception predicate defined ONCE (`is_exception_slot`), shared by read + write | The `open_slots` view (patient booking list) and `book_appointment` (enforcement) both call the same function, so the list and the write path can never drift. **Never duplicate the predicate.** Booking a now-excepted slot raises `ERR_ON_EXCEPTION_DATE`, translated to a patient-facing "slot no longer available" message (patient did nothing wrong). Canonical Manila cast: `(slot_datetime at time zone 'Asia/Manila')::date`. |
| 2026-08-15 | `0004_test_slots.sql` retained as DEV-SEED ONLY, superseded by `generate_time_slots` | The generator RPC intentionally refuses non-admin / non-request contexts (`auth.uid()` is NULL → `ERR_FORBIDDEN`), so it can't seed a fresh dev DB; `0004`'s standalone loop can, and is idempotent. For live/admin operation use the `/admin/providers` UI, not `0004`. |
| 2026-08-15 | Reschedule stays a dedicated upcoming feature, not part of the exception flow | The exception-date conflict resolver offers **Cancel only** (reuses `cancel_appointment`). Avoids two divergent reschedule paths; guided cancel-and-rebook belongs to the Reschedule feature. |
| 2026-08-16 | Global `RAW_DB_NOISE` backstop in `errors.ts` — raw Postgres/RLS errors never reach any UI | **Specific, friendly messages run FIRST** at the call site (SQLSTATE `23505`/`23514` on availability + time-off inserts; `ERR_*` maps for `generate_time_slots`, `cancel_appointment`, `book_appointment`). The backstop only catches whatever is unhandled and returns the caller's fallback, matching the existing `errorMessage` "{}"-sanitising philosophy. **Deliberately GLOBAL, not admin-only** — raw DB text (constraint names, `permission denied`, row-level-security) must not leak on the **patient** side either. It's a single choke point every `api.ts` call already funnels through, so future calls are covered with no per-call work. |
| 2026-08-16 | Availability duplicate prevented client-side before the DB | `/admin/providers` disables "Add window" + shows an inline warning when the chosen day+start already exists in the already-loaded windows (same key as the `(provider, day_of_week, start_time)` unique constraint). The `23505` translation is the fallback if the DB is still hit (stale data / race). |
| 2026-08-18 | Booking UI restructured 3-step → 4-step (Service → Date → Time → Confirm); step 2 is a month calendar | The old time-list step looked broken only because no availability was seeded from admin — not a code bug. A calendar makes availability legible: each day shows the aggregate remaining-slot count for the service (doctors are assigned by service, not chosen by the patient, so the count spans all providers that offer it). Navigable range = current month + 2; past/empty days disabled with a **non-color** signal (line-through + “—”/“Puno”) since the app is still unstyled. Month view uses ONE aggregate query (`service_daily_availability` groups open_slots by Manila date), never one-query-per-day. |
| 2026-08-18 | Two per-patient booking guards as partial unique indexes (`0011`); both exclude cancelled | Guard (a) `uniq_active_service_per_patient_day` on `(patient_id, service_id, appointment_date)` — a patient may book DIFFERENT services on the same day but not the same service twice. Guard (b) `uniq_active_time_per_patient` on `(patient_id, appointment_at)` — no two active bookings at the same instant even across services (dental 9:00 + check-up 9:00 passes (a) but is physically impossible and corrupts that day's queue). **Both carry `WHERE status <> 'cancelled'`: without the exclusion a patient who cancels could NEVER rebook that same service/date or time — the cancelled row would keep tripping the unique index.** Same rationale as the existing `uniq_active_appointment_per_slot`. Needed new stored columns because the date/time lived only on `time_slots`; `appointment_date` can't be a GENERATED column (Manila tz cast is STABLE, not IMMUTABLE), so `book_appointment` populates both. Violations raise 23505 → mapped in `errors.ts` by index name; client-side pre-checks (from the patient's own active bookings) surface the conflict before submit. |
| 2026-08-18 | Canonical phone format `+639XXXXXXXXX`, assembled client-side at submit, enforced by `profiles_phone_ph_format_chk` (migration `0010`) | Single unambiguous storage shape — **never** the bare 10 digits, **never** a leading `0`. The Register form renders a static non-editable `+63` prefix, keeps only the 10-digit subscriber number in state (digits-only, must start with 9, paste formats `09…`/`63…`/`+63…` normalized then capped at 10), and prepends `+63` only at submit. The CHECK constraint is the real enforcement (client validation is UX only); a violation raises SQLSTATE `23514`, mapped to a friendly message in `errors.ts` keyed on the constraint name (runs before the `RAW_DB_NOISE` backstop). **This canonical format is a prerequisite for the mock SMS work in Step 6** — SMS reads `profiles.phone` verbatim, so a consistent `+63…` shape means no per-send reformatting. |
| 2026-08-20 | Admin Overview volume chart is a **snapshot with manual refresh**, NOT realtime | The chart is a descriptive/historical summary — it fetches once on mount and on granularity change, plus a header **Refresh** button that refetches the current granularity and the stale-`booked` count (disabled while a fetch is in flight). A **"Updated HH:MM" timestamp** sits beside the button so it reads as a snapshot, not a live feed. **Deliberately no realtime subscription:** second-to-second accuracy doesn't matter for a rolling 30-day / 12-week / 12-month / 5-year aggregate, and realtime is reserved for the **Live Queue**, where "now serving" genuinely must be live. Staying off realtime here also keeps us within Supabase free-tier connection limits. |
| 2026-08-20 | Stale past-dated `booked` rows are SURFACED as a count, never auto-reclassified | A `booked` appointment whose `appointment_date` is already past was simply never marked `served`/`no_show` by staff — reclassifying it (to no_show or served) is a **data decision** that guesses what actually happened, and would silently rewrite the history the reports draw from. So the volume chart in `book`-status counts them as Pending, and a note beside it reads "N past appointments still marked booked — not yet closed out by staff" so staff can close them out deliberately. **Display surfaces the gap; it does not resolve it.** The count is a `head+count` query (`status='booked'` AND `appointment_date < today` Manila) — global, not range-scoped, so it's stable across the granularity toggle. |
| 2026-08-20 | Patient calendar distinguishes three unavailable states instead of one blanket "Puno" | The old calendar showed remaining = 0 as "Puno" (full) for **three different** situations, misleading patients: no schedule exists, all slots booked, or open slots whose times already passed today. `service_daily_slot_status` (`0013`) returns `remaining` / `unbooked` / `upcoming` / `total` so the client (`unavailableLabel`) maps them: no row or `total=0` → **"Walang schedule"**, `upcoming>0` → **"Puno"** (upcoming slots exist but all booked), else `unbooked>0` → **"Lipas na"** (open earlier today, now passed), else "Puno". All three stay **disabled** — only the label and footer legend changed. Aggregate excludes exception-date slots (holiday/leave reads as "Walang schedule", matching hidden-not-deleted) and keeps `slot_datetime >= now()` on `remaining`, so a 9:00 AM unbooked slot is not "available" at 2:30 PM. Verified NOT an undercount: today's open slots were a different service than the one viewed. |

---

## 10. Known Issues / TODO

- 4 docs files were deleted by the Vite `--overwrite` scaffold: `mho-client-pitch-guide.md`, `mho-defense-playbook.md`, `mho-appointment-plan.md`, `mho-appointment-prompts.md` — restore from backup if available.
- Seeded auth.users rows break GoTrue login (NULL token columns + missing auth.identities → HTTP 500 → client shows "{}"). Fix: `0005_repair_seeded_auth_users.sql`; seed.sql patched so re-seeds include the repair. RESOLVED — login verified working.
- ACTION NEEDED: disable "Confirm email" (Authentication → Sign In / Providers → Email) — it's currently ON and blocks registration (no session returned). After disabling, rerun `node scripts/register-test.mjs` — expect ALL PASS.
- Test users from register-test linger in auth.users. Cleanup: `delete from auth.users where email like 'reg.test.%@gmail.com';`

---

## 11. Git / Deploy Notes

- **GitHub identity:** John Carlo's account, set `--local` sa repo (HINDI Kintooki, HINDI BuildEase client identity)
- **Secrets:** Only `VITE_`-prefixed public Supabase keys sa Vercel. service_role key at DATABASE_URL EXCLUDED.
- **Before any demo:** wake the Supabase project (free tier idles)
