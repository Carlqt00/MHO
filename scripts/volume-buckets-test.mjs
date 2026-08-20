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
