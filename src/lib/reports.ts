import type { VolumeBucket } from './volume'

export type RangePreset = 'day' | 'week' | 'month' | 'year' | 'custom'
export type ReportStatus = 'all' | 'booked' | 'checked_in' | 'served' | 'cancelled' | 'no_show'

export interface ReportRange {
  preset: RangePreset
  from: string
  to: string
  label: string
  fileLabel: string
}

export interface ReportFilters {
  reportType: string
  status: ReportStatus
  range: ReportRange
}

export interface AppointmentReportRow {
  id: string
  appointmentAt: string
  appointmentDate: string
  patient: string
  patientId: string
  service: string
  serviceId: string
  provider: string
  providerId: string
  ticketNumber: string
  queueNumber: number | null
  status: Exclude<ReportStatus, 'all'>
}

export interface ReportCount {
  name: string
  count: number
  served: number
  cancelled: number
  no_show: number
}

export interface ReportData {
  filters: ReportFilters
  generatedAt: Date
  rows: AppointmentReportRow[]
  summary: {
    booked: number
    checked_in: number
    served: number
    no_show: number
    cancelled: number
    total: number
  }
  patients: {
    total: number
    newInRange: number
    uniqueWithAppointment: number
    uniqueServed: number
  }
  rates: {
    noShowRate: number
    cancelledRate: number
    completionRate: number
  }
  volume: VolumeBucket[]
  volumeMode: 'day' | 'month'
  byService: ReportCount[]
  byProvider: ReportCount[]
}

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  all: 'All Statuses',
  booked: 'Booked',
  checked_in: 'Checked In',
  served: 'Served',
  cancelled: 'Cancelled',
  no_show: 'No-show',
}

export const PRESET_LABEL: Record<RangePreset, string> = {
  day: 'This day',
  week: 'This week',
  month: 'This month',
  year: 'This year',
  custom: 'Custom Range',
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

function mondayOf(s: string): string {
  const dow = parseYMD(s).getUTCDay()
  const diff = dow === 0 ? -6 : 1 - dow
  return addDays(s, diff)
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

export function presetRange(preset: Exclude<RangePreset, 'custom'>, today: string): ReportRange {
  const d = parseYMD(today)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()

  switch (preset) {
    case 'day':
      return { preset, from: today, to: today, label: longDate(today), fileLabel: today }
    case 'week': {
      const from = mondayOf(today)
      const to = addDays(from, 6)
      return { preset, from, to, label: `${longDate(from)} - ${longDate(to)}`, fileLabel: `${from}_to_${to}` }
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

export function customRange(from: string, to: string): ReportRange {
  return {
    preset: 'custom',
    from,
    to,
    label: `${longDate(from)} - ${longDate(to)}`,
    fileLabel: `${from}_to_${to}`,
  }
}

export function reportVolumePeriods(range: ReportRange): string[] {
  const out: string[] = []
  if (range.preset === 'year') {
    const year = Number(range.from.slice(0, 4))
    for (let month = 0; month < 12; month++) out.push(fmtYMD(new Date(Date.UTC(year, month, 1))))
    return out
  }

  let current = range.from
  while (current <= range.to) {
    out.push(current)
    current = addDays(current, 1)
  }
  return out
}

export function reportVolumeMode(range: ReportRange): 'day' | 'month' {
  return range.preset === 'year' ? 'month' : 'day'
}
