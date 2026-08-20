# Admin Patient-Volume Stacked Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stacked patient-volume bar chart (Attended / No-show / Cancelled / Pending) with a Day/Week/Month/Year toggle, no-show & cancellation rates, and a stale-`booked` note to the Admin Overview page.

**Architecture:** Four aggregate RPCs (one per granularity) group `appointments` by their Manila `appointment_date` (migration 0012, SECURITY INVOKER, following `service_daily_availability` from 0011). A pure, framework-free helper module (`src/lib/volume.ts`) computes date ranges, generates the full bucket list, zero-fills gaps, and derives the rates. A plain CSS/flex `VolumeChart` React component (no charting dependency) renders patterned stacked bars with a legend and per-bar totals, and is placed below the existing stat cards on `AdminOverview`.

**Tech Stack:** React 19 + TypeScript + Vite, Tailwind CSS v4, Supabase (PostgreSQL), Node 24 (native `.ts` type-stripping for the verification script).

**Spec:** The task brief in the initiating conversation (stacked patient-volume chart on Admin Overview). No separate spec file.

## Global Constraints

- **Descriptive analytics only** — plain aggregation of past data, no forecasting.
- **Bar total = all appointments with `appointment_date` in that period**, regardless of final status. Segments show what became of them.
- **Segment order bottom→top:** Attended (`checked_in`/`served`), No-show (`no_show`), Cancelled (`cancelled`), Pending (`booked`).
- **Status spellings are exact:** `'booked'`, `'checked_in'`, `'served'`, `'cancelled'` (double-l), `'no_show'`.
- **Granularity windows:** Day → last 30 days · Week → last 12 weeks · Month → last 12 months · Year → last 5 years.
- **Empty periods render as zero-height bars, not gaps.**
- **Non-color signal required** on every segment + a legend (color-blind / unstyled-UI safe).
- **Show the total above each bar.**
- **Group by `appointments.appointment_date`** (the Manila-date column from 0011) — never a client-side conversion of `appointment_at`.
- **One aggregate query per granularity** — never one query per bucket, never pull raw appointment rows to the client to count in JS.
- **New RPCs go in `supabase/migrations/0012_*.sql`, idempotent (`CREATE OR REPLACE`), and are NOT applied** — the author runs it.
- **All DB errors go through `errorMessage(...)` in `src/lib/errors.ts`** with a friendly fallback — no raw Postgres text in the UI.
- **Do NOT auto-reclassify stale `booked` rows** — surface a count only.
- **Do NOT style page-by-page** beyond what's structural — the chart bars are structural, not decoration (per the project's deferred holistic UI/UX pass).

---

### Task 1: Pure volume helpers + Node verification script

**Files:**
- Create: `src/lib/volume.ts`
- Test: `scripts/volume-buckets-test.mjs`

**Interfaces:**
- Consumes: nothing (pure, no imports).
- Produces:
  - `type Granularity = 'day' | 'week' | 'month' | 'year'`
  - `interface VolumeBucket { period: string; attended: number; no_show: number; cancelled: number; pending: number; total: number }`
  - `interface VolumeRange { from: string; to: string }`
  - `interface VolumeRates { total: number; noShow: number; cancelled: number; noShowRate: number; cancelledRate: number }`
  - `const GRANULARITY_CONFIG: Record<Granularity, { label: string; count: number; rpc: string }>`
  - `function bucketsFor(g: Granularity, today: string): string[]` — ordered `'YYYY-MM-DD'` bucket-start keys.
  - `function rangeFor(g: Granularity, today: string): VolumeRange` — inclusive `from`/`to` Manila dates; `to` is the END of the final bucket (captures already-booked future dates within the current period).
  - `function zeroFill(rows: VolumeBucket[], periods: string[]): VolumeBucket[]`
  - `function computeRates(buckets: VolumeBucket[]): VolumeRates`
  - `function mondayOf(s: string): string` (exported so the test can assert week alignment directly).

**Edge cases the test MUST cover** (these are the correctness-critical ones — the whole point of the pure module):
- Week bucket crossing a **month** boundary — `2026-08-31` (Mon) → week runs Aug 31 … Sep 6.
- Week bucket crossing a **year** boundary — `2025-12-29` (Mon) → week runs Dec 29 2025 … Jan 4 2026; weeks stay exactly 7 days apart across the boundary.
- **February incl. leap year** — Feb 29 2024 present in the day window; no phantom `2025-02-29`; month-range `to` = `2024-02-29` (leap) vs `2025-02-28` (non-leap).
- **Zero-fill of a whole empty bucket** — `zeroFill([], periods)` returns every period as an all-zero row, in order.
- **Rate math at zero total** — `0%`, never `NaN`.

- [ ] **Step 1: Write the failing test** — `scripts/volume-buckets-test.mjs`

```js
// ============================================================
// volume-buckets-test.mjs — verifies the pure date/bucket math
// behind the admin patient-volume chart. No DB, no dependencies.
// Relies on Node 24 native .ts type-stripping to import volume.ts.
//
// Run:  node scripts/volume-buckets-test.mjs
// ============================================================
import {
  bucketsFor,
  rangeFor,
  zeroFill,
  computeRates,
  mondayOf,
} from '../src/lib/volume.ts'

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(`${name} (got ${a})`, a === e)
}

const TODAY = '2026-08-20' // a fixed reference date

// --- day: last 30 days ending today ---
const days = bucketsFor('day', TODAY)
eq("bucketsFor('day').length", days.length, 30)
eq("bucketsFor('day') first", days[0], '2026-07-22')
eq("bucketsFor('day') last", days[29], TODAY)
eq("rangeFor('day')", rangeFor('day', TODAY), { from: '2026-07-22', to: '2026-08-20' })

// --- week: 12 ISO (Monday-start) weeks ---
const weeks = bucketsFor('week', TODAY)
eq("bucketsFor('week').length", weeks.length, 12)
check("bucketsFor('week') all Mondays", weeks.every((w) => new Date(w + 'T00:00:00Z').getUTCDay() === 1))
check(
  "bucketsFor('week') 7 days apart ascending",
  weeks.every((w, i) => i === 0 || (new Date(w) - new Date(weeks[i - 1])) === 7 * 86400000)
)
eq("bucketsFor('week') last === mondayOf(today)", weeks[11], mondayOf(TODAY))

// --- month: last 12 months ---
const months = bucketsFor('month', TODAY)
eq("bucketsFor('month').length", months.length, 12)
eq("bucketsFor('month') first", months[0], '2025-09-01')
eq("bucketsFor('month') last", months[11], '2026-08-01')
eq("rangeFor('month') to = end of Aug", rangeFor('month', TODAY).to, '2026-08-31')

// --- year: last 5 years ---
const years = bucketsFor('year', TODAY)
eq("bucketsFor('year')", years, ['2022-01-01', '2023-01-01', '2024-01-01', '2025-01-01', '2026-01-01'])
eq("rangeFor('year') to = end of year", rangeFor('year', TODAY).to, '2026-12-31')

// --- range START snapped to a bucket boundary (no partial leading bar) ---
// TODAY (2026-08-20) is a THURSDAY, mid-week and mid-month, so these prove
// the start snaps back to the bucket boundary rather than starting mid-period.
eq("rangeFor('day').from = first day bucket", rangeFor('day', TODAY).from, bucketsFor('day', TODAY)[0])
eq("rangeFor('week').from = first week bucket", rangeFor('week', TODAY).from, bucketsFor('week', TODAY)[0])
eq("rangeFor('month').from = first month bucket", rangeFor('month', TODAY).from, bucketsFor('month', TODAY)[0])
eq("rangeFor('year').from = first year bucket", rangeFor('year', TODAY).from, bucketsFor('year', TODAY)[0])
check("rangeFor('week').from snaps to a Monday", new Date(rangeFor('week', TODAY).from + 'T00:00:00Z').getUTCDay() === 1)
eq("rangeFor('month').from snaps to the 1st", rangeFor('month', TODAY).from, '2025-09-01')
eq("rangeFor('year').from snaps to Jan 1", rangeFor('year', TODAY).from, '2022-01-01')

// --- zeroFill: missing periods become zero rows, order preserved ---
const filled = zeroFill(
  [{ period: '2026-08-01', attended: 3, no_show: 1, cancelled: 0, pending: 2, total: 6 }],
  ['2026-07-01', '2026-08-01']
)
eq('zeroFill fills empty period', filled[0], { period: '2026-07-01', attended: 0, no_show: 0, cancelled: 0, pending: 0, total: 0 })
eq('zeroFill keeps present period', filled[1].total, 6)

// --- computeRates: sums + divide-by-zero guard ---
const rates = computeRates([
  { period: 'a', attended: 5, no_show: 2, cancelled: 3, pending: 0, total: 10 },
  { period: 'b', attended: 5, no_show: 0, cancelled: 0, pending: 5, total: 10 },
])
eq('computeRates totals', [rates.total, rates.noShow, rates.cancelled], [20, 2, 3])
check('computeRates noShowRate', Math.abs(rates.noShowRate - 0.1) < 1e-9)
check('computeRates cancelledRate', Math.abs(rates.cancelledRate - 0.15) < 1e-9)
const zero = computeRates([])
eq('computeRates divide-by-zero guard', [zero.noShowRate, zero.cancelledRate], [0, 0])

// ============================================================
// Edge cases
// ============================================================
const asMs = (s) => new Date(s + 'T00:00:00Z').getTime()
const toYMD = (ms) => new Date(ms).toISOString().slice(0, 10)

// --- week bucket crossing a MONTH boundary (Aug 31 – Sep 1) ---
// 2026-08-31 is a Monday; its ISO week runs Aug 31 → Sep 6.
check('mondayOf across month boundary', mondayOf('2026-09-01') === '2026-08-31')
{
  const w = bucketsFor('week', '2026-09-01')
  eq('week bucket last = Mon 2026-08-31', w[11], '2026-08-31')
  const end = toYMD(asMs(w[11]) + 6 * 86400000)
  eq('week bucket spans Aug→Sep', [w[11].slice(5, 7), end.slice(5, 7)], ['08', '09'])
}

// --- week bucket crossing a YEAR boundary (Dec 29 – Jan 4) ---
// 2025-12-29 is a Monday; its ISO week runs Dec 29 2025 → Jan 4 2026.
check('mondayOf across year boundary', mondayOf('2026-01-04') === '2025-12-29')
{
  const w = bucketsFor('week', '2026-01-04')
  eq('week bucket last = Mon 2025-12-29', w[11], '2025-12-29')
  const end = toYMD(asMs(w[11]) + 6 * 86400000)
  eq('year-crossing week spans 2025→2026', [w[11].slice(0, 4), end.slice(0, 4)], ['2025', '2026'])
  check(
    'weeks stay 7 days apart across the year boundary',
    w.every((x, i) => i === 0 || asMs(x) - asMs(w[i - 1]) === 7 * 86400000)
  )
}

// --- February, including a LEAP year ---
// 2024 is a leap year: the 30-day window ending Mar 1 2024 includes Feb 29.
{
  const leapDays = bucketsFor('day', '2024-03-01')
  check('leap day 2024-02-29 present', leapDays.includes('2024-02-29'))
  check('every day bucket round-trips to a real date', leapDays.every((d) => d === toYMD(asMs(d))))
}
// 2025 is NOT a leap year: Feb 29 must never appear.
check('no phantom 2025-02-29', !bucketsFor('day', '2025-03-01').includes('2025-02-29'))
// month-range end honors leap vs non-leap February.
eq('rangeFor month to = leap Feb last day', rangeFor('month', '2024-02-10').to, '2024-02-29')
eq('rangeFor month to = non-leap Feb last day', rangeFor('month', '2025-02-10').to, '2025-02-28')

// --- zero-fill when a WHOLE bucket has no appointment (no rows at all) ---
{
  const periods = bucketsFor('week', '2026-01-04')
  const allZero = zeroFill([], periods)
  eq('zeroFill with no rows keeps every bucket', allZero.length, periods.length)
  check(
    'zeroFill with no rows is all zeros',
    allZero.every(
      (b) => b.total === 0 && b.attended === 0 && b.no_show === 0 && b.cancelled === 0 && b.pending === 0
    )
  )
  check('zeroFill preserves bucket order', allZero.every((b, i) => b.period === periods[i]))
}

// --- rate math when total is zero → 0%, never NaN ---
{
  const r = computeRates([
    { period: '2026-01-01', attended: 0, no_show: 0, cancelled: 0, pending: 0, total: 0 },
  ])
  eq('all-zero bucket → 0 rates', [r.noShowRate, r.cancelledRate], [0, 0])
  check('rates are numbers, never NaN', !Number.isNaN(r.noShowRate) && !Number.isNaN(r.cancelledRate))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/volume-buckets-test.mjs`
Expected: FAIL — `Cannot find module '../src/lib/volume.ts'` (file does not exist yet).

- [ ] **Step 3: Write the implementation** — `src/lib/volume.ts`

```ts
// Pure, framework-free helpers behind the admin patient-volume chart.
// No imports so a plain Node .mjs (24+ type-stripping) can verify them.
// All dates are Manila calendar dates as 'YYYY-MM-DD' strings; arithmetic
// runs on UTC-midnight Date objects so it is timezone-agnostic (we never
// look at the time component — only the calendar label matters).

export type Granularity = 'day' | 'week' | 'month' | 'year'

export interface VolumeBucket {
  period: string // 'YYYY-MM-DD' Manila — bucket start
  attended: number
  no_show: number
  cancelled: number
  pending: number
  total: number
}

export interface VolumeRange {
  from: string // inclusive 'YYYY-MM-DD'
  to: string // inclusive 'YYYY-MM-DD' — END of the final bucket
}

export interface VolumeRates {
  total: number
  noShow: number
  cancelled: number
  noShowRate: number
  cancelledRate: number
}

// count = number of buckets; rpc = the migration-0012 function to call.
export const GRANULARITY_CONFIG: Record<
  Granularity,
  { label: string; count: number; rpc: string }
> = {
  day: { label: 'Day', count: 30, rpc: 'appointment_volume_by_day' },
  week: { label: 'Week', count: 12, rpc: 'appointment_volume_by_week' },
  month: { label: 'Month', count: 12, rpc: 'appointment_volume_by_month' },
  year: { label: 'Year', count: 5, rpc: 'appointment_volume_by_year' },
}

function parseYMD(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function fmtYMD(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDaysYMD(s: string, n: number): string {
  const d = parseYMD(s)
  d.setUTCDate(d.getUTCDate() + n)
  return fmtYMD(d)
}

// Monday of the ISO week containing `s`. Matches Postgres
// date_trunc('week', <date>)::date (ISO week, Monday start).
export function mondayOf(s: string): string {
  const dow = parseYMD(s).getUTCDay() // 0=Sun … 6=Sat
  const diff = dow === 0 ? -6 : 1 - dow
  return addDaysYMD(s, diff)
}

// Ordered bucket-start keys for the granularity, ending with the bucket
// that contains `today`.
export function bucketsFor(g: Granularity, today: string): string[] {
  const out: string[] = []
  switch (g) {
    case 'day':
      for (let i = 29; i >= 0; i--) out.push(addDaysYMD(today, -i))
      return out
    case 'week': {
      const mon = mondayOf(today)
      for (let i = 11; i >= 0; i--) out.push(addDaysYMD(mon, -7 * i))
      return out
    }
    case 'month': {
      const d = parseYMD(today)
      const y = d.getUTCFullYear()
      const m = d.getUTCMonth() // 0-based
      for (let i = 11; i >= 0; i--) out.push(fmtYMD(new Date(Date.UTC(y, m - i, 1))))
      return out
    }
    case 'year': {
      const y = parseYMD(today).getUTCFullYear()
      for (let i = 4; i >= 0; i--) out.push(`${y - i}-01-01`)
      return out
    }
  }
}

// Inclusive [from, to] passed to the RPC. `to` is the END of the final
// bucket, so already-booked future dates within the current period are
// counted as demand (they show up as Pending).
export function rangeFor(g: Granularity, today: string): VolumeRange {
  const periods = bucketsFor(g, today)
  const from = periods[0]
  const last = periods[periods.length - 1]
  let to: string
  switch (g) {
    case 'day':
      to = today
      break
    case 'week':
      to = addDaysYMD(last, 6)
      break
    case 'month': {
      const d = parseYMD(last)
      to = fmtYMD(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)))
      break
    }
    case 'year':
      to = `${parseYMD(last).getUTCFullYear()}-12-31`
      break
  }
  return { from, to }
}

const EMPTY = (period: string): VolumeBucket => ({
  period,
  attended: 0,
  no_show: 0,
  cancelled: 0,
  pending: 0,
  total: 0,
})

// Map RPC rows onto the full ordered bucket list; missing periods become
// zero rows so the chart renders zero-height bars, not gaps.
export function zeroFill(rows: VolumeBucket[], periods: string[]): VolumeBucket[] {
  const byPeriod = new Map(rows.map((r) => [r.period, r]))
  return periods.map((p) => byPeriod.get(p) ?? EMPTY(p))
}

// Aggregate no-show / cancellation rates over the visible buckets, with a
// divide-by-zero guard (empty range → 0).
export function computeRates(buckets: VolumeBucket[]): VolumeRates {
  let total = 0
  let noShow = 0
  let cancelled = 0
  for (const b of buckets) {
    total += b.total
    noShow += b.no_show
    cancelled += b.cancelled
  }
  return {
    total,
    noShow,
    cancelled,
    noShowRate: total ? noShow / total : 0,
    cancelledRate: total ? cancelled / total : 0,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/volume-buckets-test.mjs`
Expected: PASS — every `✓`, final line `ALL PASS`, exit 0.

- [ ] **Step 5: Typecheck the new module**

Run: `npx tsc --noEmit -p tsconfig.app.json` (or the project's app tsconfig; fall back to `npx tsc --noEmit`)
Expected: no errors.

---

### Task 2: Migration 0012 — four aggregate RPCs (NOT applied)

**Files:**
- Create: `supabase/migrations/0012_appointment_volume.sql`

**Interfaces:**
- Consumes: `appointments.appointment_date` (Manila date, migration 0011); status values `booked`/`checked_in`/`served`/`cancelled`/`no_show`; RLS `staff/admin: select all appointments` (0002) so a SECURITY INVOKER aggregate sees every row for an admin caller.
- Produces four RPCs, each `returns table (period date, attended int, no_show int, cancelled int, pending int, total int)`:
  - `appointment_volume_by_day(p_from date, p_to date)`
  - `appointment_volume_by_week(p_from date, p_to date)`
  - `appointment_volume_by_month(p_from date, p_to date)`
  - `appointment_volume_by_year(p_from date, p_to date)`

- [ ] **Step 1: Write the migration** — `supabase/migrations/0012_appointment_volume.sql`

```sql
-- ============================================================
-- 0012_appointment_volume.sql
-- Descriptive analytics for the admin Overview patient-volume chart.
-- Four aggregate RPCs (one per granularity) return status counts grouped
-- by period. NO forecasting — plain aggregation of past bookings.
--
-- SCHEMA FACTS this migration relies on (verified against 0001 / 0011):
--   * appointments.status is TEXT, CHECK-limited to
--     ('booked','checked_in','served','cancelled','no_show').
--   * appointments.appointment_date is the stored Manila calendar date
--     (added in 0011, RPC-populated). We group by THIS column — never a
--     re-derivation of appointment_at — so the buckets match the booking
--     guards and the calendar.
--
-- Segment definitions (bottom→top in the UI):
--   attended  = status in ('checked_in','served')
--   no_show   = status  = 'no_show'
--   cancelled = status  = 'cancelled'
--   pending   = status  = 'booked'
--   total     = every row in the period, regardless of status (= demand)
--
-- SECURITY INVOKER (same as service_daily_availability in 0011): the
-- caller's RLS applies. The admin "staff/admin: select all appointments"
-- policy (0002) exposes every row incl. cancelled, so an admin gets true
-- totals; a non-admin caller would only ever aggregate their own rows.
--
-- Idempotent / re-runnable: CREATE OR REPLACE for every function.
-- NOT YET APPLIED — the author runs this.
-- ============================================================

-- ------------------------------------------------------------
-- Day: one bucket per Manila calendar date.
-- ------------------------------------------------------------
create or replace function public.appointment_volume_by_day(p_from date, p_to date)
returns table (period date, attended int, no_show int, cancelled int, pending int, total int)
language sql
stable
security invoker
set search_path = public
as $$
  select a.appointment_date as period,
         count(*) filter (where a.status in ('checked_in','served'))::int as attended,
         count(*) filter (where a.status = 'no_show')::int                as no_show,
         count(*) filter (where a.status = 'cancelled')::int              as cancelled,
         count(*) filter (where a.status = 'booked')::int                 as pending,
         count(*)::int                                                    as total
  from public.appointments a
  where a.appointment_date between p_from and p_to
  group by a.appointment_date
  order by a.appointment_date;
$$;

grant execute on function public.appointment_volume_by_day(date, date) to authenticated;

-- ------------------------------------------------------------
-- Week: ISO week (Monday start) via date_trunc, cast back to date.
-- ------------------------------------------------------------
create or replace function public.appointment_volume_by_week(p_from date, p_to date)
returns table (period date, attended int, no_show int, cancelled int, pending int, total int)
language sql
stable
security invoker
set search_path = public
as $$
  select date_trunc('week', a.appointment_date)::date as period,
         count(*) filter (where a.status in ('checked_in','served'))::int as attended,
         count(*) filter (where a.status = 'no_show')::int                as no_show,
         count(*) filter (where a.status = 'cancelled')::int              as cancelled,
         count(*) filter (where a.status = 'booked')::int                 as pending,
         count(*)::int                                                    as total
  from public.appointments a
  where a.appointment_date between p_from and p_to
  group by 1
  order by 1;
$$;

grant execute on function public.appointment_volume_by_week(date, date) to authenticated;

-- ------------------------------------------------------------
-- Month: first-of-month bucket.
-- ------------------------------------------------------------
create or replace function public.appointment_volume_by_month(p_from date, p_to date)
returns table (period date, attended int, no_show int, cancelled int, pending int, total int)
language sql
stable
security invoker
set search_path = public
as $$
  select date_trunc('month', a.appointment_date)::date as period,
         count(*) filter (where a.status in ('checked_in','served'))::int as attended,
         count(*) filter (where a.status = 'no_show')::int                as no_show,
         count(*) filter (where a.status = 'cancelled')::int              as cancelled,
         count(*) filter (where a.status = 'booked')::int                 as pending,
         count(*)::int                                                    as total
  from public.appointments a
  where a.appointment_date between p_from and p_to
  group by 1
  order by 1;
$$;

grant execute on function public.appointment_volume_by_month(date, date) to authenticated;

-- ------------------------------------------------------------
-- Year: first-of-year bucket.
-- ------------------------------------------------------------
create or replace function public.appointment_volume_by_year(p_from date, p_to date)
returns table (period date, attended int, no_show int, cancelled int, pending int, total int)
language sql
stable
security invoker
set search_path = public
as $$
  select date_trunc('year', a.appointment_date)::date as period,
         count(*) filter (where a.status in ('checked_in','served'))::int as attended,
         count(*) filter (where a.status = 'no_show')::int                as no_show,
         count(*) filter (where a.status = 'cancelled')::int              as cancelled,
         count(*) filter (where a.status = 'booked')::int                 as pending,
         count(*)::int                                                    as total
  from public.appointments a
  where a.appointment_date between p_from and p_to
  group by 1
  order by 1;
$$;

grant execute on function public.appointment_volume_by_year(date, date) to authenticated;
```

- [ ] **Step 2: Self-review the migration (no apply)**

Verify by reading — DO NOT run the SQL:
- All four functions are `create or replace`, `security invoker`, `stable`, `set search_path = public`, and each has a matching `grant execute ... to authenticated`.
- Grouping column is `appointment_date` (day) or `date_trunc(..., appointment_date)` (week/month/year) — never `appointment_at`.
- Status predicates match the exact spellings and the segment definitions.
- Return column order/types match the `VolumeBucket` shape from Task 1 (`period, attended, no_show, cancelled, pending, total`).
Expected: all true. The author applies the migration themselves later.

---

### Task 3: API layer — volume + stale-booked count

**Files:**
- Modify: `src/lib/api.ts`

**Interfaces:**
- Consumes: `VolumeBucket` type from `src/lib/volume.ts`; `supabase`, `errorMessage`, `GENERIC_ERR` already in `api.ts`; the four RPC names.
- Produces:
  - `async function fetchAppointmentVolume(rpc: string, from: string, to: string): Promise<VolumeBucket[]>`
  - `async function fetchStaleBookedCount(todayManila: string): Promise<number>`

- [ ] **Step 1: Add the import** — top of `src/lib/api.ts`, after the existing imports

```ts
import type { VolumeBucket } from './volume'
```

- [ ] **Step 2: Add the two functions** — append near the other admin helpers in `src/lib/api.ts`

```ts
// ------------------------------------------------------------
// Admin: patient-volume descriptive analytics (Overview chart)
// ------------------------------------------------------------

// ONE aggregate query per granularity. `rpc` is one of the migration-0012
// function names (see GRANULARITY_CONFIG in volume.ts). Returns only the
// periods that have rows; the caller zero-fills the gaps. RLS scopes an
// admin to every appointment, so totals are true totals.
export async function fetchAppointmentVolume(
  rpc: string,
  from: string,
  to: string
): Promise<VolumeBucket[]> {
  const { data, error } = await supabase.rpc(rpc, { p_from: from, p_to: to })
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return (data ?? []) as VolumeBucket[]
}

// Count of past-dated appointments still marked 'booked' — never closed
// out by staff. head+count only (no rows fetched); we surface the number
// but NEVER auto-reclassify (that is a data decision, not a display one).
export async function fetchStaleBookedCount(todayManila: string): Promise<number> {
  const { count, error } = await supabase
    .from('appointments')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'booked')
    .lt('appointment_date', todayManila)
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return count ?? 0
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json` (fall back to `npx tsc --noEmit`)
Expected: no errors.

---

### Task 4: `VolumeChart` component + wire into Admin Overview

**Files:**
- Create: `src/components/VolumeChart.tsx`
- Modify: `src/pages/admin/AdminOverview.tsx`

**Interfaces:**
- Consumes: `GRANULARITY_CONFIG`, `bucketsFor`, `rangeFor`, `zeroFill`, `computeRates`, types `Granularity`/`VolumeBucket` from `src/lib/volume.ts`; `fetchAppointmentVolume`, `fetchStaleBookedCount` from `src/lib/api.ts`; `errorMessage` from `src/lib/errors.ts`.
- Produces: `export function VolumeChart()` — a self-contained section managing its own granularity/data/loading/error state.

- [ ] **Step 1: Write the component** — `src/components/VolumeChart.tsx`

```tsx
import { useEffect, useMemo, useState } from 'react'
import {
  GRANULARITY_CONFIG,
  bucketsFor,
  rangeFor,
  zeroFill,
  computeRates,
  type Granularity,
  type VolumeBucket,
} from '../lib/volume'
import { fetchAppointmentVolume, fetchStaleBookedCount } from '../lib/api'
import { errorMessage } from '../lib/errors'

const GRANULARITIES: Granularity[] = ['day', 'week', 'month', 'year']

// Segment order is BOTTOM→TOP. SOLID COLOR is the primary signal; the
// pattern is a subtle secondary overlay only (dropped on thin segments so
// they don't go muddy). No-show (bright orange) and cancelled (dark red)
// are adjacent + both red-family, so they are separated by LUMINANCE
// (bright vs dark) — distinguishable in a thin bar and in grayscale.
// `text` is the in-bar number colour, chosen for contrast against `color`:
// white on the dark fills, near-black on the light (orange/amber) fills.
type SegKey = 'attended' | 'no_show' | 'cancelled' | 'pending'
const SEGMENTS: {
  key: SegKey
  label: string
  meaning: string
  color: string
  text: string
  pattern: 'solid' | 'diagonal' | 'cross' | 'dots'
}[] = [
  { key: 'attended', label: 'Attended', meaning: 'checked-in / served', color: '#166534', text: '#ffffff', pattern: 'solid' },
  { key: 'no_show', label: 'No-show', meaning: 'no_show', color: '#f97316', text: '#111827', pattern: 'diagonal' },
  { key: 'cancelled', label: 'Cancelled', meaning: 'cancelled', color: '#b91c1c', text: '#ffffff', pattern: 'cross' },
  { key: 'pending', label: 'Pending', meaning: 'booked', color: '#eab308', text: '#111827', pattern: 'dots' },
]

// Solid fill first; a faint white pattern layered on top when withPattern.
// Colour reads at a glance; the pattern is a quiet secondary cue.
function fillStyle(color: string, pattern: string, withPattern: boolean): React.CSSProperties {
  const base: React.CSSProperties = { backgroundColor: color }
  if (!withPattern || pattern === 'solid') return base
  const line = 'rgba(255,255,255,0.18)'
  switch (pattern) {
    case 'diagonal':
      return {
        ...base,
        backgroundImage: `repeating-linear-gradient(45deg, ${line} 0 3px, transparent 3px 7px)`,
      }
    case 'cross':
      return {
        ...base,
        backgroundImage: `repeating-linear-gradient(45deg, ${line} 0 2px, transparent 2px 7px), repeating-linear-gradient(-45deg, ${line} 0 2px, transparent 2px 7px)`,
      }
    case 'dots':
      return {
        ...base,
        backgroundImage: `radial-gradient(rgba(255,255,255,0.22) 1.4px, transparent 1.6px)`,
        backgroundSize: '7px 7px',
      }
    default:
      return base
  }
}

const manilaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })

// X-axis label. Every period stays on the axis, but the coarser unit is
// only shown when it changes (or on the first bar) so labels stay short:
//   day / week → day-of-month, month prefixed on change → "Jul 22 … 31, Aug 1, 2 …"
//   month      → month, year appended on change          → "Sep … Dec, Jan '26 …"
//   year       → the year                                → "2022, 2023 …"
function axisLabel(period: string, prev: string | null, g: Granularity): string {
  const [y, m, d] = period.split('-').map(Number)
  const mon = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
  })
  const prevY = prev ? Number(prev.slice(0, 4)) : null
  const prevM = prev ? Number(prev.slice(5, 7)) : null
  switch (g) {
    case 'day':
    case 'week':
      return prev && m === prevM ? String(d) : `${mon} ${d}`
    case 'month':
      return prev && y === prevY ? mon : `${mon} '${String(y).slice(2)}`
    case 'year':
      return String(y)
  }
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

// Snapshot timestamp in Manila local time (e.g. "3:45 PM").
const formatUpdated = (d: Date) =>
  d.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    minute: '2-digit',
  })

const CHART_HEIGHT = 200 // px

export function VolumeChart() {
  const [granularity, setGranularity] = useState<Granularity>('day')
  const [buckets, setBuckets] = useState<VolumeBucket[]>([])
  const [staleCount, setStaleCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  // Bumped by the Refresh button to re-run the fetch effect. This chart is a
  // SNAPSHOT, not a live feed — no realtime subscription (that belongs to the
  // Live Queue, and staying off realtime here respects free-tier connection
  // limits). `lastUpdated` makes the snapshot nature visible.
  const [refreshKey, setRefreshKey] = useState(0)

  // Volume + stale-booked count, refetched on granularity change and on manual
  // refresh. `loading` is set true by the triggers (initial state, the toggle
  // handler, the refresh handler), never synchronously here, so the effect
  // only touches state inside async callbacks (avoids the cascading-render
  // lint rule).
  useEffect(() => {
    let active = true
    const today = manilaToday()
    const cfg = GRANULARITY_CONFIG[granularity]
    const { from, to } = rangeFor(granularity, today)
    Promise.all([fetchAppointmentVolume(cfg.rpc, from, to), fetchStaleBookedCount(today)])
      .then(([rows, stale]) => {
        if (!active) return
        setBuckets(zeroFill(rows, bucketsFor(granularity, today)))
        setStaleCount(stale)
        setError('')
        setLastUpdated(new Date())
      })
      .catch((e: unknown) => active && setError(errorMessage(e, 'Failed to load the volume chart.')))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [granularity, refreshKey])

  const refresh = () => {
    if (loading) return
    setLoading(true)
    setRefreshKey((k) => k + 1)
  }

  const rates = useMemo(() => computeRates(buckets), [buckets])
  const maxTotal = useMemo(() => Math.max(1, ...buckets.map((b) => b.total)), [buckets])

  return (
    <section className="mt-8 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-gray-800">Patient Volume</h3>
          <p className="text-sm text-gray-500">
            Total appointments booked per period, by what became of them.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400" aria-live="polite">
              {lastUpdated ? `Updated ${formatUpdated(lastUpdated)}` : 'Loading…'}
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              title="Refresh — this chart is a snapshot, not a live feed"
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 disabled:opacity-50"
            >
              ↻ Refresh
            </button>
          </div>
          <div className="flex gap-1" role="group" aria-label="Chart granularity">
            {GRANULARITIES.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => {
                  if (g === granularity) return
                  setLoading(true)
                  setGranularity(g)
                }}
                aria-pressed={granularity === g}
                className={`rounded-md border px-3 py-1 text-sm ${
                  granularity === g
                    ? 'border-gray-800 bg-gray-800 text-white'
                    : 'border-gray-300 bg-white text-gray-700'
                }`}
              >
                {GRANULARITY_CONFIG[g].label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      {/* Legend — pattern swatch + label + status meaning (non-color signal). */}
      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {SEGMENTS.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-4 w-4 rounded-sm border border-gray-300"
              style={fillStyle(s.color, s.pattern, true)}
            />
            <span className="text-gray-700">
              {s.label} <span className="text-gray-400">({s.meaning})</span>
            </span>
          </li>
        ))}
      </ul>

      {/* Chart. Empty periods still render as zero-height bars (not gaps). */}
      <div className="mt-4 overflow-x-auto">
        <div className="flex items-end gap-1" style={{ height: CHART_HEIGHT + 48 }}>
          {loading ? (
            <p className="self-center text-sm text-gray-400">Loading…</p>
          ) : (
            buckets.map((b, i) => (
              <div key={b.period} className="flex min-w-[18px] flex-1 flex-col items-center">
                {/* Total above the bar — omitted for empty periods; the nbsp keeps
                    the row height uniform so all bar baselines still line up. */}
                <span className="mb-0.5 text-[10px] font-medium text-gray-600">
                  {b.total > 0 ? b.total : ' '}
                </span>
                <div
                  className="flex w-full flex-col justify-end border-b border-gray-200"
                  style={{ height: CHART_HEIGHT }}
                >
                  {/* top→bottom render = reversed segment order so Attended sits at the bottom */}
                  {[...SEGMENTS].reverse().map((s) => {
                    const value = b[s.key]
                    if (value === 0) return null
                    const h = (value / maxTotal) * CHART_HEIGHT
                    // Drop the pattern on thin segments so the solid colour stays clean.
                    const withPattern = h >= 20
                    return (
                      <div
                        key={s.key}
                        title={`${s.label}: ${value}`}
                        className="flex items-center justify-center overflow-hidden text-[9px] font-semibold"
                        style={{ height: h, color: s.text, ...fillStyle(s.color, s.pattern, withPattern) }}
                      >
                        {h >= 14 ? value : ''}
                      </div>
                    )
                  })}
                </div>
                {/* Day mode packs 30 bars — rotate labels so every day-of-month
                    stays readable without truncating. Coarser modes sit flat. */}
                {granularity === 'day' ? (
                  <div className="mt-1 flex h-7 w-full justify-center">
                    <span className="origin-top -rotate-45 whitespace-nowrap text-[9px] leading-none text-gray-500">
                      {axisLabel(b.period, i > 0 ? buckets[i - 1].period : null, granularity)}
                    </span>
                  </div>
                ) : (
                  <span className="mt-1 w-full whitespace-nowrap text-center text-[9px] text-gray-500">
                    {axisLabel(b.period, i > 0 ? buckets[i - 1].period : null, granularity)}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Derived figures — surfaced, not buried in the chart. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-gray-200 p-3">
          <p className="text-sm text-gray-500">No-show rate</p>
          <p className="text-2xl font-bold text-gray-900">{pct(rates.noShowRate)}</p>
          <p className="text-xs text-gray-400">
            {rates.noShow} of {rates.total} in view
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 p-3">
          <p className="text-sm text-gray-500">Cancellation rate</p>
          <p className="text-2xl font-bold text-gray-900">{pct(rates.cancelledRate)}</p>
          <p className="text-xs text-gray-400">
            {rates.cancelled} of {rates.total} in view
          </p>
        </div>
      </div>

      {/* Stale-booked note. NOT auto-reclassified — surfaced for staff. */}
      {staleCount > 0 && (
        <p className="mt-3 text-sm text-amber-700">
          ⚠ {staleCount} past appointment{staleCount === 1 ? '' : 's'} still marked booked — not yet
          closed out by staff.
        </p>
      )}
    </section>
  )
}
```

- [ ] **Step 2: Wire it into `AdminOverview`** — `src/pages/admin/AdminOverview.tsx`

Add the import after the existing imports:

```tsx
import { VolumeChart } from '../../components/VolumeChart'
```

Then render it directly after the closing `</div>` of the stat-cards grid, still inside the `<section>` (replace the grid's closing lines):

```tsx
      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {CARDS.map((card) => (
          <div key={card.key} className="rounded-xl border border-gray-200 bg-white p-5">
            <p className="text-sm text-gray-500">{card.label}</p>
            <p className="mt-2 text-3xl font-bold text-gray-900">
              {loading ? <span className="text-gray-300">…</span> : (stats?.[card.key] ?? 0)}
            </p>
          </div>
        ))}
      </div>

      <VolumeChart />
    </section>
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `npx tsc --noEmit -p tsconfig.app.json` then `npm run lint` then `npm run build`
Expected: no type errors, no lint errors, successful build.

- [ ] **Step 4: Manual verification (in-app)**

Run `npm run dev`, log in as admin, open `/admin`. Confirm below the stat cards:
- Stacked bars render with the four segments patterned + a legend.
- Day/Week/Month/Year toggle swaps the bars (30 / 12 / 12 / 5 bars respectively).
- Total sits above each bar; empty periods are zero-height bars, not gaps.
- No-show rate and cancellation rate show below the chart.
- The stale-booked note appears only when there are past `booked` rows.
- No raw Postgres text appears on any error (kill the network to spot-check the error banner).

---

### Task 5: Documentation update

**Files:**
- Modify: `docs/project_context.md`

**Interfaces:**
- Consumes: nothing. Produces prose only.

- [ ] **Step 1: Record migration 0012 in the migration history** — in the blockquote at the top of section 5, append after the `0011` entry:

```
· `0012` **appointment volume analytics** — four SECURITY INVOKER aggregate RPCs (`appointment_volume_by_day/week/month/year(from, to)`) returning per-period status counts (attended / no_show / cancelled / pending / total) grouped by `appointments.appointment_date`, backing the admin Overview patient-volume chart. Follows the `service_daily_availability` pattern. Idempotent; **not yet applied** (author runs it).
```

- [ ] **Step 2: Note the volume chart under the descriptive-analytics work** — in section 8 (Build Order), under the Reports item (Step 7), add a sub-note:

```
> **Descriptive analytics (2026-08-20):** Admin Overview now has a stacked patient-volume chart below the stat cards — one bar per period (Day=30d / Week=12w / Month=12mo / Year=5y), height = total demand, segments = Attended / No-show / Cancelled / Pending. Plain CSS/flex bars (no charting dependency), patterned segments + legend for the unstyled/color-blind-safe requirement. No-show and cancellation rates for the visible range are shown below the chart. Pure date/bucket math in `src/lib/volume.ts`, verified by `scripts/volume-buckets-test.mjs` (Node 24 type-stripping, no new dep). Aggregation only — no forecasting.
```

- [ ] **Step 3: Add the decisions-log entry** — append a row to the section 9 table:

```
| 2026-08-20 | Stale past-dated `booked` rows are SURFACED as a count, never auto-reclassified | A `booked` appointment whose `appointment_date` is already past was simply never marked `served`/`no_show` by staff — reclassifying it (to no_show or served) is a data decision that guesses what actually happened, and would silently rewrite history the reports then draw from. The Overview shows "N past appointments still marked booked — not yet closed out by staff" so staff can close them out deliberately. Display surfaces the gap; it does not resolve it. |
```

- [ ] **Step 4: Verify the edits**

Read back the three edited spots in `docs/project_context.md` and confirm the migration history, build-order note, and decisions-log row are present and accurate.

---

## Self-Review

**1. Spec coverage:**
- Stacked bar, one per period, total height = all appts by `appointment_date` → Task 2 RPCs + Task 4 render. ✓
- Segment order & status mapping → SEGMENTS + RPC filters. ✓
- Granularity toggle (Day 30 / Week 12 / Month 12 / Year 5) → `GRANULARITY_CONFIG` + `bucketsFor`. ✓
- Empty periods = zero bars → `zeroFill` + render (Task 1/4). ✓
- Legend + non-color signal → patterned segments + patterned-swatch legend + per-segment value + total (Task 4). ✓
- Total above each bar → Task 4. ✓
- No-show & cancellation rates for visible range → `computeRates` + rates panel. ✓
- Stale `booked` count note, no auto-reclassify → `fetchStaleBookedCount` + note + decisions-log (Task 3/4/5). ✓
- One aggregate RPC per granularity, group by `appointment_date`, follow `service_daily_availability`, migration 0012, idempotent, not applied → Task 2. ✓
- Placement below stat cards → Task 4 Step 2. ✓
- Errors via `errors.ts` → all API calls use `errorMessage`; component uses `errorMessage` fallback. ✓
- No charting dep / plain CSS-flex → Task 4 uses flex + inline patterns only. ✓
- Docs update → Task 5. ✓

**2. Placeholder scan:** No TBD/TODO/"add error handling"/"similar to" — every step carries full code. ✓

**3. Type consistency:** `VolumeBucket` shape (`period, attended, no_show, cancelled, pending, total`) is identical across `volume.ts`, the RPC return columns, `api.ts`, and the component's `b[s.key]` access (`SegKey` ⊂ `VolumeBucket` numeric keys). RPC names in `GRANULARITY_CONFIG` match the four function names in migration 0012. `fetchAppointmentVolume(rpc, from, to)` / `fetchStaleBookedCount(todayManila)` signatures match their call sites. ✓
