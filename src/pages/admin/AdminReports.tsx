import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminEmptyState, AdminPageHeader, AdminStatCard } from '../../components/AdminPrimitives'
import { ReportVolumeChart } from '../../components/VolumeChart'
import {
  fetchAppointmentSummary,
  fetchAppointmentVolume,
  fetchPatientStats,
  fetchReportByProvider,
  fetchReportByService,
  type ReportCount,
} from '../../lib/api'
import { exportReportExcel, exportReportPdf } from '../../lib/reportExport'
import {
  manilaToday,
  presetRange,
  PRESET_LABEL,
  reportVolumePeriods,
  reportVolumeRpc,
  type RangePreset,
  type ReportData,
} from '../../lib/reports'
import { zeroFill } from '../../lib/volume'

const PRESETS: RangePreset[] = ['week', 'month', 'year']
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

export function AdminReports() {
  const [preset, setPreset] = useState<RangePreset>('month')
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      const range = presetRange(preset, manilaToday())
      const volumeMode = preset === 'year' ? 'month' : 'day'
      try {
        const [summary, volumeRows, byService, byProvider, patients] = await Promise.all([
          fetchAppointmentSummary(range.from, range.to),
          fetchAppointmentVolume(reportVolumeRpc(preset), range.from, range.to),
          fetchReportByService(range.from, range.to),
          fetchReportByProvider(range.from, range.to),
          fetchPatientStats(range.from, range.to),
        ])
        if (cancelled) return
        const rates = {
          noShowRate: summary.total ? summary.no_show / summary.total : 0,
          cancelledRate: summary.total ? summary.cancelled / summary.total : 0,
        }
        const volume = zeroFill(volumeRows, reportVolumePeriods(range))
        setData({
          range,
          generatedAt: new Date(),
          summary,
          rates,
          volume,
          volumeMode,
          byService,
          byProvider,
          patients,
        })
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
  }, [preset])

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
              ? `${data.range.label} · Generated ${generatedLabel(data.generatedAt)}`
              : 'Generate appointment reports and export operational summaries.'
          }
          actions={
            <>
            <div className="inline-flex rounded-xl border border-emerald-100 bg-white p-1 shadow-sm" role="group" aria-label="Report period">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    if (p !== preset) setPreset(p)
                  }}
                  aria-pressed={preset === p}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                    preset === p
                      ? 'bg-emerald-700 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-emerald-50 hover:text-emerald-800'
                  }`}
                >
                  {PRESET_LABEL[p]}
                </button>
              ))}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => data && void exportReportPdf(data)}
                disabled={!data || loading}
                className="btn-subtle min-h-10 flex-1 px-3 py-2 sm:flex-none"
              >
                Export PDF
              </button>
              <button
                type="button"
                onClick={() => data && void exportReportExcel(data)}
                disabled={!data || loading}
                className="btn-primary min-h-10 flex-1 px-3 py-2 sm:flex-none"
              >
                Export Excel
              </button>
            </div>
            </>
          }
        />

        {error && (
          <div className="alert-error" role="alert">
            {error}
          </div>
        )}

        {loading || !data ? (
          <section className="card card-pad">
            <p className="text-slate-400">Loading reports…</p>
          </section>
        ) : (
          <>
            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <AdminStatCard label="Booked" value={data.summary.booked} detail="Booked in period" tone="amber" />
              <AdminStatCard label="Checked in" value={data.summary.checked_in} detail="Arrived patients" tone="sky" />
              <AdminStatCard label="Served" value={data.summary.served} detail="Completed visits" />
              <AdminStatCard label="Total" value={data.summary.total} detail={`${data.range.from} to ${data.range.to}`} />
            </section>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(22rem,0.8fr)]">
              <section className="card min-w-0 overflow-hidden">
                <div className="border-b border-emerald-100 bg-white px-4 py-4 sm:px-6">
                  <p className="section-kicker">Patient Volume</p>
                  <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">Appointment trends</h3>
                  <p className="mt-1 text-sm text-slate-500">
                    Appointments by {data.volumeMode === 'month' ? 'month' : 'day'}
                  </p>
                </div>
                <div className="p-4 sm:p-6">
                  <ReportVolumeChart buckets={data.volume} mode={data.volumeMode} />
                </div>
              </section>

              <div className="space-y-6">
                <section className="card card-pad">
                  <h3 className="text-lg font-semibold text-slate-950">By Service</h3>
                  <div className="mt-4">
                    <CountTable rows={data.byService} />
                  </div>
                </section>

                <section className="card card-pad">
                  <h3 className="text-lg font-semibold text-slate-950">Rates</h3>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                    <RateStat label="No-show rate" value={pct(data.rates.noShowRate)} />
                    <RateStat label="Cancellation rate" value={pct(data.rates.cancelledRate)} />
                  </div>
                </section>
              </div>
            </div>
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
            <th className="px-4 py-3 font-semibold">Service</th>
            <th className="px-4 py-3 text-right font-semibold">Appointments</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td className="px-4 py-3 font-medium text-slate-700">{row.name}</td>
              <td className="px-4 py-3 text-right font-semibold text-slate-950">{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
