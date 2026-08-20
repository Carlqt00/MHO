# MHO Centralized Appointment & Ticketing System

Web-based appointment and ticketing system for the Daraga Municipal Health Office (MHO), Albay. Capstone project by John Carlo Montales & Ronian Rañola (BSIT, CATC). Methodology: Agile. Evaluation framework: ISO 25010.

## Before doing ANY work

Read `project_context.md` in full first. It contains the complete scope, database schema, roles/RBAC, critical logic notes, seed data, and build order. Follow it strictly and keep it updated as the build progresses.

## Non-negotiable guardrails

- **Stay in scope.** Build ONLY: appointment scheduling, ticketing/queue, appointment-scoped patient records, provider availability, notifications, announcements, reports. If a proposed feature falls outside this, STOP and flag it before building.
- **Never build (delimited out in the manuscript):** EMR / clinical data, billing / payments / insurance, telemedicine / online consultation, emergency handling, multi-facility. These are defense risks.
- **Race-safe booking is critical.** Two patients must never book the same slot — use a DB-level lock/transaction.
- **RLS enforced.** A patient must never see another patient's data.

## Tech stack

React + TypeScript + Vite + Supabase (PostgreSQL, auth, realtime). Hosting: Vercel + Supabase. PDF export via jsPDF; Excel export via SheetJS.

## Workflow rules

- Build small flows first — one end-to-end flow at a time, not the whole system at once. See the build order in `project_context.md`.
- Patient-facing copy: Taglish-friendly and accessible (large fonts, simple navigation). Staff/admin copy: English.
- Update `project_context.md` (decisions log, known issues, build order checkboxes) whenever something is completed.
- Use real seed data: 3 doctors, 1 dentist, 5 nurses; real MHO hours; services = Immunization, Prenatal, General Check-up, Dental.

## Git & secrets

- Git identity = John Carlo's account, set `--local` in this repo (NOT any other identity).
- Only `VITE_`-prefixed public Supabase keys go to the client/Vercel. The service_role key and DATABASE_URL are excluded from the repo.
- Wake the Supabase project before any live demo (free tier idles).
