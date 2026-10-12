import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminEmptyState, AdminPageHeader, AdminStatCard } from '../../components/AdminPrimitives'
import { ReportVolumeChart } from '../../components/VolumeChart'
import {
  fetchAppointmentReportRows,
  fetchPatientStats,
  fetchServices,
  type Service,
} from '../../lib/api'
import { exportReportExcel, exportReportPdf } from '../../lib/reportExport'
import {
  customRange,
  manilaToday,
  presetRange,
  PRESET_LABEL,
  REPORT_STATUS_LABEL,
  reportVolumeMode,
  reportVolumePeriods,
  type AppointmentReportRow,
  type RangePreset,
  type ReportCount,
  type ReportData,
  type ReportFilters,
  type ReportStatus,
} from '../../lib/reports'
import type { VolumeBucket } from '../../lib/volume'

const PRESETS: RangePreset[] = ['day', 'week', 'month', 'year', 'custom']
const STATUSES: ReportStatus[] = ['all', 'booked', 'checked_in', 'served', 'cancelled', 'no_show']
const PAGE_SIZE = 20

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

const generatedLabel = (d: Date) =>
  d.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusPill(status: AppointmentReportRow['status']) {
  const label = REPORT_STATUS_LABEL[status]
  const tone =
    status === 'served'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'checked_in'
        ? 'bg-sky-100 text-sky-800'
        : status === 'booked'
          ? 'bg-amber-100 text-amber-800'
          : status === 'cancelled'
            ? 'bg-rose-100 text-rose-800'
            : 'bg-orange-100 text-orange-800'
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{label}</span>
}

function emptyBucket(period: string): VolumeBucket {
  return { period, attended: 0, no_show: 0, cancelled: 0, pending: 0, total: 0 }
}

function buildCounts(rows: AppointmentReportRow[], key: 'service' | 'provider'): ReportCount[] {
  const map = new Map<string, ReportCount>()
  for (const row of rows) {
    const name = row[key]
    const current = map.get(name) ?? { name, count: 0, served: 0, cancelled: 0, no_show: 0 }
    current.count += 1
    if (row.status === 'served') current.served += 1
    if (row.status === 'cancelled') current.cancelled += 1
    if (row.status === 'no_show') current.no_show += 1
    map.set(name, current)
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function buildReportData(input: {
  filters: ReportFilters
  rows: AppointmentReportRow[]
  patientTotals: { total: number; newInRange: number }
  generatedAt: Date
}): ReportData {
  const rows = input.rows
  const summary = {
    booked: rows.filter((row) => row.status === 'booked').length,
    checked_in: rows.filter((row) => row.status === 'checked_in').length,
    served: rows.filter((row) => row.status === 'served').length,
    no_show: rows.filter((row) => row.status === 'no_show').length,
    cancelled: rows.filter((row) => row.status === 'cancelled').length,
    total: rows.length,
  }
  const total = summary.total
  const periods = reportVolumePeriods(input.filters.range)
  const mode = reportVolumeMode(input.filters.range)
  const buckets = new Map(periods.map((period) => [period, emptyBucket(period)]))
  for (const row of rows) {
    const period = mode === 'month' ? `${row.appointmentDate.slice(0, 7)}-01` : row.appointmentDate
    const bucket = buckets.get(period)
    if (!bucket) continue
    bucket.total += 1
    if (row.status === 'no_show') bucket.no_show += 1
    if (row.status === 'cancelled') bucket.cancelled += 1
    if (row.status === 'booked') bucket.pending += 1
    if (row.status === 'checked_in' || row.status === 'served') bucket.attended += 1
  }

  return {
    filters: input.filters,
    generatedAt: input.generatedAt,
    rows,
    summary,
    patients: {
      total: input.patientTotals.total,
      newInRange: input.patientTotals.newInRange,
      uniqueWithAppointment: new Set(rows.map((row) => row.patientId)).size,
      uniqueServed: new Set(rows.filter((row) => row.status === 'served').map((row) => row.patientId)).size,
    },
    rates: {
      noShowRate: total ? summary.no_show / total : 0,
      cancelledRate: total ? summary.cancelled / total : 0,
      completionRate: total ? summary.served / total : 0,
    },
    volume: periods.map((period) => buckets.get(period) ?? emptyBucket(period)),
    volumeMode: mode,
    byService: buildCounts(rows, 'service'),
    byProvider: buildCounts(rows, 'provider'),
  }
}

export function AdminReports() {
  const today = useMemo(() => manilaToday(), [])
  const [services, setServices] = useState<Service[]>([])
  const [reportType, setReportType] = useState('general')
  const [status, setStatus] = useState<ReportStatus>('all')
  const [preset, setPreset] = useState<RangePreset>('month')
  const [customFrom, setCustomFrom] = useState(today)
  const [customTo, setCustomTo] = useState(today)
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)

  const selectedService = services.find((service) => service.id === reportType) ?? null
  const range = useMemo(() => {
    if (preset === 'custom') {
      const from = customFrom <= customTo ? customFrom : customTo
      const to = customFrom <= customTo ? customTo : customFrom
      return customRange(from, to)
    }
    return presetRange(preset, today)
  }, [customFrom, customTo, preset, today])

  useEffect(() => {
    fetchServices()
      .then(setServices)
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const [rows, patients] = await Promise.all([
          fetchAppointmentReportRows({
            from: range.from,
            to: range.to,
            serviceId: selectedService?.id,
            status,
          }),
          fetchPatientStats(range.from, range.to),
        ])
        if (cancelled) return
        setData(
          buildReportData({
            filters: {
              reportType: selectedService?.name ?? 'General Report',
              status,
              range,
            },
            rows,
            patientTotals: { total: patients.total, newInRange: patients.newInRange },
            generatedAt: new Date(),
          })
        )
        setPage(1)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [range, selectedService?.id, selectedService?.name, status])

  const totalPages = data ? Math.max(1, Math.ceil(data.rows.length / PAGE_SIZE)) : 1
  const visibleRows = data?.rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) ?? []
  const reportTitle = selectedService ? `${selectedService.name} Report` : 'General Report'

  return (
    <div className="space-y-6">
      <Link
        to="/staff"
        className="inline-flex min-h-10 items-center rounded-lg border border-emerald-100 bg-white px-3 py-2 text-sm font-medium text-emerald-800 shadow-sm transition hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-950"
      >
        Back to Staff Dashboard
      </Link>

      <AdminPageHeader
        title="Reports"
        subtitle={
          data
            ? `${reportTitle} · ${REPORT_STATUS_LABEL[status]} · ${data.filters.range.label} · Generated ${generatedLabel(data.generatedAt)}`
            : 'Generate detailed appointment reports from actual MHO records.'
        }
        actions={
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => data && void exportReportPdf(data)}
              disabled={!data || loading}
              className="btn-subtle min-h-10 px-3 py-2"
            >
              Export PDF
            </button>
            <button
              type="button"
              onClick={() => data && void exportReportExcel(data)}
              disabled={!data || loading}
              className="btn-primary min-h-10 px-3 py-2"
            >
              Export Excel
            </button>
          </div>
        }
      />

      <section className="rounded-2xl border border-emerald-100 bg-white p-4 shadow-sm shadow-emerald-950/5">
        <div className="grid gap-3 lg:grid-cols-[minmax(12rem,1fr)_minmax(12rem,0.8fr)]">
          <label className="text-sm font-semibold text-slate-700">
            Report Type
            <select
              value={reportType}
              onChange={(event) => setReportType(event.target.value)}
              className="mt-1 w-full rounded-xl border border-emerald-100 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-emerald-500 focus:outline-none"
            >
              <option value="general">General Report</option>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm font-semibold text-slate-700">
            Status
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as ReportStatus)}
              className="mt-1 w-full rounded-xl border border-emerald-100 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-emerald-500 focus:outline-none"
            >
              {STATUSES.map((item) => (
                <option key={item} value={item}>
                  {REPORT_STATUS_LABEL[item]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {PRESETS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setPreset(item)}
              aria-pressed={preset === item}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                preset === item
                  ? 'bg-emerald-700 text-white shadow-sm'
                  : 'border border-emerald-100 bg-white text-slate-600 hover:bg-emerald-50 hover:text-emerald-800'
              }`}
            >
              {PRESET_LABEL[item]}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-semibold text-slate-700">
              Start Date
              <input
                type="date"
                value={customFrom}
                onChange={(event) => setCustomFrom(event.target.value)}
                className="mt-1 w-full rounded-xl border border-emerald-100 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <label className="text-sm font-semibold text-slate-700">
              End Date
              <input
                type="date"
                value={customTo}
                onChange={(event) => setCustomTo(event.target.value)}
                className="mt-1 w-full rounded-xl border border-emerald-100 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-emerald-500 focus:outline-none"
              />
            </label>
          </div>
        )}
      </section>

      {error && (
        <div className="alert-error" role="alert">
          {error}
        </div>
      )}

      {loading || !data ? (
        <section className="card card-pad">
          <p className="text-slate-400">Loading reports...</p>
        </section>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            <AdminStatCard label="Total" value={data.summary.total} detail="Filtered records" />
            <AdminStatCard label="Booked" value={data.summary.booked} detail="Filtered records" tone="amber" />
            <AdminStatCard label="Checked In" value={data.summary.checked_in} detail="Filtered records" tone="sky" />
            <AdminStatCard label="Served" value={data.summary.served} detail="Filtered records" />
            <AdminStatCard label="Cancelled" value={data.summary.cancelled} detail="Filtered records" tone="red" />
            <AdminStatCard label="No-show" value={data.summary.no_show} detail="Filtered records" tone="amber" />
          </section>

          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <AdminStatCard label="Registered Patients" value={data.patients.total} detail="All patient accounts" />
            <AdminStatCard label="New Registrations" value={data.patients.newInRange} detail={data.filters.range.label} />
            <AdminStatCard label="Patients With Appointment" value={data.patients.uniqueWithAppointment} detail="Filtered rows" />
            <AdminStatCard label="Patients Served" value={data.patients.uniqueServed} detail="Filtered rows" />
          </section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(22rem,0.8fr)]">
            <section className="card min-w-0 overflow-hidden">
              <div className="border-b border-emerald-100 bg-white px-4 py-4 sm:px-6">
                <p className="section-kicker">Appointment Trend</p>
                <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
                  {reportTitle}
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Appointments by {data.volumeMode === 'month' ? 'month' : 'day'} for the current filters
                </p>
              </div>
              <div className="p-4 sm:p-6">
                <ReportVolumeChart buckets={data.volume} mode={data.volumeMode} />
              </div>
            </section>

            <div className="space-y-6">
              <section className="card card-pad">
                <h3 className="text-lg font-semibold text-slate-950">
                  {selectedService ? 'Provider Breakdown' : 'Service Distribution'}
                </h3>
                <div className="mt-4">
                  <CountTable rows={selectedService ? data.byProvider : data.byService} />
                </div>
              </section>

              <section className="card card-pad">
                <h3 className="text-lg font-semibold text-slate-950">Rates</h3>
                <div className="mt-4 grid gap-3">
                  <RateStat label="No-show rate" value={pct(data.rates.noShowRate)} />
                  <RateStat label="Cancellation rate" value={pct(data.rates.cancelledRate)} />
                  <RateStat label="Completion rate" value={pct(data.rates.completionRate)} />
                </div>
              </section>
            </div>
          </div>

          <section className="card overflow-hidden">
            <div className="border-b border-emerald-100 bg-white px-4 py-4 sm:px-6">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="section-kicker">Detailed Appointment Records</p>
                  <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
                    {data.summary.total} filtered record{data.summary.total === 1 ? '' : 's'}
                  </h3>
                </div>
                <p className="text-sm text-slate-500">
                  Page {page} of {totalPages}
                </p>
              </div>
            </div>

            {data.rows.length === 0 ? (
              <div className="p-4 sm:p-6">
                <AdminEmptyState>No appointment records found for the selected filters.</AdminEmptyState>
              </div>
            ) : (
              <>
                <div className="table-shell rounded-none border-0">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th className="px-4 py-3 font-semibold">Date</th>
                        <th className="px-4 py-3 font-semibold">Time</th>
                        <th className="px-4 py-3 font-semibold">Patient</th>
                        <th className="px-4 py-3 font-semibold">Service</th>
                        <th className="px-4 py-3 font-semibold">Provider</th>
                        <th className="px-4 py-3 font-semibold">Ticket</th>
                        <th className="px-4 py-3 text-right font-semibold">Queue</th>
                        <th className="px-4 py-3 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((row) => (
                        <tr key={row.id}>
                          <td className="px-4 py-3 text-slate-700">{formatDate(row.appointmentAt)}</td>
                          <td className="px-4 py-3 text-slate-700">{formatTime(row.appointmentAt)}</td>
                          <td className="px-4 py-3 font-medium text-slate-900">{row.patient}</td>
                          <td className="px-4 py-3 text-slate-700">{row.service}</td>
                          <td className="px-4 py-3 text-slate-700">{row.provider}</td>
                          <td className="px-4 py-3 text-slate-700">{row.ticketNumber || '-'}</td>
                          <td className="px-4 py-3 text-right text-slate-700">{row.queueNumber ?? '-'}</td>
                          <td className="px-4 py-3">{statusPill(row.status)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-col gap-3 border-t border-emerald-100 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                  <p className="text-sm text-slate-500">
                    Showing {(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, data.rows.length)} of {data.rows.length}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                      disabled={page === 1}
                      className="btn-subtle min-h-9 px-3 py-1"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                      disabled={page === totalPages}
                      className="btn-subtle min-h-9 px-3 py-1"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function RateStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-4">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-slate-950">{value}</p>
    </div>
  )
}

function CountTable({ rows }: { rows: ReportCount[] }) {
  if (rows.length === 0) {
    return <AdminEmptyState>No appointments in this period.</AdminEmptyState>
  }
  return (
    <div className="table-shell">
      <table className="data-table">
        <thead>
          <tr>
            <th className="px-4 py-3 font-semibold">Name</th>
            <th className="px-4 py-3 text-right font-semibold">Total</th>
            <th className="px-4 py-3 text-right font-semibold">Served</th>
            <th className="px-4 py-3 text-right font-semibold">No-show</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td className="px-4 py-3 font-medium text-slate-700">{row.name}</td>
              <td className="px-4 py-3 text-right font-semibold text-slate-950">{row.count}</td>
              <td className="px-4 py-3 text-right text-slate-700">{row.served}</td>
              <td className="px-4 py-3 text-right text-slate-700">{row.no_show}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
