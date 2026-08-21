// Pure helpers for the admin/staff Reports page: the three range presets and
// the shared report-data shape. Manila calendar dates as 'YYYY-MM-DD'; date
// math runs on UTC-midnight Dates (time component is never read).
import { mondayOf } from './volume'

export type RangePreset = 'week' | 'month' | 'year'

export interface ReportRange {
  preset: RangePreset
  from: string // inclusive 'YYYY-MM-DD' (Manila)
  to: string // inclusive
  label: string // for display + export header
  fileLabel: string // for the export filename
}

// One object holding every figure for the selected range. The screen AND both
// exports read from THIS — one source, so a printout can never drift from what
// was on screen.
export interface ReportData {
  range: ReportRange
  generatedAt: Date
  summary: {
    booked: number
    checked_in: number
    served: number
    no_show: number
    cancelled: number
    total: number
  }
  rates: { noShowRate: number; cancelledRate: number }
  byService: { name: string; count: number }[]
  byProvider: { name: string; count: number }[]
  patients: { total: number; newInRange: number; active: number }
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function parseYMD(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
function fmtYMD(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function addDays(s: string, n: number): string {
  const d = parseYMD(s)
  d.setUTCDate(d.getUTCDate() + n)
  return fmtYMD(d)
}
function longDate(ymd: string): string {
  return parseYMD(ymd).toLocaleDateString('en-PH', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function manilaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
}

// Calendar-based presets (not the chart's rolling windows):
//   week  → Mon–Sun of the current ISO week (matches volume.ts / Postgres)
//   month → 1st–last of the current month
//   year  → Jan 1 – Dec 31 of the current year
export function presetRange(preset: RangePreset, today: string): ReportRange {
  const d = parseYMD(today)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() // 0-based
  switch (preset) {
    case 'week': {
      const from = mondayOf(today)
      const to = addDays(from, 6)
      return { preset, from, to, label: `${longDate(from)} – ${longDate(to)}`, fileLabel: `${from}_to_${to}` }
    }
    case 'month': {
      const from = fmtYMD(new Date(Date.UTC(y, m, 1)))
      const to = fmtYMD(new Date(Date.UTC(y, m + 1, 0)))
      return { preset, from, to, label: `${MONTHS[m]} ${y}`, fileLabel: `${y}-${pad2(m + 1)}` }
    }
    case 'year':
      return { preset, from: `${y}-01-01`, to: `${y}-12-31`, label: String(y), fileLabel: String(y) }
  }
}

export const PRESET_LABEL: Record<RangePreset, string> = {
  week: 'This week',
  month: 'This month',
  year: 'This year',
}
