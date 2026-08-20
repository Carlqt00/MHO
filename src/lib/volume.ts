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
