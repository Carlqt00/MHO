import { useEffect, useState } from 'react'
import {
  fetchAppointmentSummary,
  fetchReportByService,
  fetchReportByProvider,
  fetchPatientStats,
  type ReportCount,
} from '../../lib/api'
import {
  manilaToday,
  presetRange,
  PRESET_LABEL,
  type RangePreset,
  type ReportData,
} from '../../lib/reports'
import { exportReportPdf, exportReportExcel } from '../../lib/reportExport'

const PRESETS: RangePreset[] = ['week', 'month', 'year']
const pct = (n: number) => `${(n * 100).toFixed(1)}%`

const generatedLabel = (d: Date) =>
  d.toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' })

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
      try {
        const [summary, byService, byProvider, patients] = await Promise.all([
          fetchAppointmentSummary(range.from, range.to),
          fetchReportByService(range.from, range.to),
          fetchReportByProvider(range.from, range.to),
          fetchPatientStats(range.from, range.to),
        ])
        if (cancelled) return
        // Rates derived from the SAME summary — no second query path.
        const rates = {
          noShowRate: summary.total ? summary.no_show / summary.total : 0,
          cancelledRate: summary.total ? summary.cancelled / summary.total : 0,
        }
        setData({ range, generatedAt: new Date(), summary, rates, byService, byProvider, patients })
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="section-title">Reports</h2>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Date range">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                if (p !== preset) setPreset(p)
              }}
              aria-pressed={preset === p}
              className={`rounded-md border px-3 py-1 text-sm ${
                preset === p
                  ? 'border-emerald-800 bg-emerald-800 text-white'
                  : 'border-emerald-200 bg-white text-slate-700 hover:bg-emerald-50'
              }`}
            >
              {PRESET_LABEL[p]}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="alert-error" role="alert">
          {error}
        </div>
      )}

      {loading || !data ? (
        <p className="text-slate-400">Loading…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-600">
              Period: <span className="font-medium">{data.range.label}</span>{' '}
              <span className="text-slate-400">
                ({data.range.from} to {data.range.to})
              </span>
              <br />
              <span className="text-xs text-slate-400">
                Generated {generatedLabel(data.generatedAt)}
              </span>
            </p>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              <button type="button" onClick={() => void exportReportPdf(data)} className="btn-subtle min-h-9 px-3 py-1">
                Export PDF
              </button>
              <button type="button" onClick={() => void exportReportExcel(data)} className="btn-subtle min-h-9 px-3 py-1">
                Export Excel
              </button>
            </div>
          </div>

          {/* 1. Appointments summary */}
          <Section title="Appointments Summary">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Booked" value={data.summary.booked} />
              <Stat label="Checked in" value={data.summary.checked_in} />
              <Stat label="Served" value={data.summary.served} />
              <Stat label="No-show" value={data.summary.no_show} />
              <Stat label="Cancelled" value={data.summary.cancelled} />
              <Stat label="Total" value={data.summary.total} />
            </div>
          </Section>

          {/* 4. Rates */}
          <Section title="Rates">
            <div className="grid gap-3 sm:grid-cols-2">
              <Stat label="No-show rate" value={pct(data.rates.noShowRate)} />
              <Stat label="Cancellation rate" value={pct(data.rates.cancelledRate)} />
            </div>
          </Section>

          {/* 2. By service */}
          <Section title="By Service">
            <CountTable rows={data.byService} firstColumn="Service" />
          </Section>

          {/* 3. By provider */}
          <Section title="By Provider">
            <CountTable rows={data.byProvider} firstColumn="Provider" />
          </Section>

          {/* 5. Patient statistics — counts only */}
          <Section title="Patient Statistics">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label="Total registered patients" value={data.patients.total} />
              <Stat label="New registrations (this period)" value={data.patients.newInRange} />
              <Stat label="Patients with an appointment (this period)" value={data.patients.active} />
            </div>
          </Section>
        </>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card card-pad">
      <h3 className="mb-3 text-base font-semibold text-slate-900">{title}</h3>
      {children}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-3">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="break-words text-2xl font-bold text-slate-950">{value}</p>
    </div>
  )
}

function CountTable({ rows, firstColumn }: { rows: ReportCount[]; firstColumn: string }) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">No appointments in this period.</p>
  }
  return (
    <div className="table-shell shadow-none">
      <table className="data-table mobile-card-table">
      <thead>
        <tr>
          <th>{firstColumn}</th>
          <th>Appointments</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} className="text-slate-700">
            <td data-label={firstColumn}>{r.name}</td>
            <td data-label="Appointments">{r.count}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}
