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
import { fetchAppointmentVolume, fetchStaleBookedCount, type AdminStats } from '../lib/api'
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
  {
    key: 'attended',
    label: 'Attended',
    meaning: 'checked-in / served',
    color: '#166534',
    text: '#ffffff',
    pattern: 'solid',
  },
  {
    key: 'no_show',
    label: 'No-show',
    meaning: 'no_show',
    color: '#f97316',
    text: '#111827',
    pattern: 'diagonal',
  },
  {
    key: 'cancelled',
    label: 'Cancelled',
    meaning: 'cancelled',
    color: '#b91c1c',
    text: '#ffffff',
    pattern: 'cross',
  },
  {
    key: 'pending',
    label: 'Pending',
    meaning: 'booked',
    color: '#eab308',
    text: '#111827',
    pattern: 'dots',
  },
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

const countLabel = (n: number, singular: string, plural = `${singular}s`) =>
  `${n} ${n === 1 ? singular : plural}`

// Snapshot timestamp in Manila local time (e.g. "3:45 PM").
const formatUpdated = (d: Date) =>
  d.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    minute: '2-digit',
  })

const CHART_HEIGHT = 200 // px

const OVERVIEW_CHART_HEIGHT = 260 // px

function reportAxisLabel(period: string, mode: 'day' | 'month'): string {
  const [y, m, d] = period.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: mode === 'day' ? 'numeric' : undefined,
  })
}

export function ReportVolumeChart({
  buckets,
  mode,
}: {
  buckets: VolumeBucket[]
  mode: 'day' | 'month'
}) {
  const maxTotal = Math.max(1, ...buckets.map((bucket) => bucket.total))
  const minWidth = mode === 'day' && buckets.length > 14 ? 'min-w-[42rem]' : 'min-w-full'

  if (buckets.length === 0) {
    return <p className="text-sm text-slate-500">No appointments in this period.</p>
  }

  return (
    <div className="max-w-full overflow-x-auto pb-1">
      <div className={`flex items-end gap-2 ${minWidth}`} style={{ height: CHART_HEIGHT + 54 }}>
        {buckets.map((bucket) => {
          const height = Math.max(4, (bucket.total / maxTotal) * CHART_HEIGHT)
          return (
            <div key={bucket.period} className="flex min-w-0 flex-1 flex-col items-center">
              <span className="mb-1 h-4 text-[10px] font-semibold text-slate-600">
                {bucket.total > 0 ? bucket.total : ''}
              </span>
              <div className="flex h-[200px] w-full items-end rounded-t-lg border-b border-emerald-100 bg-emerald-50/70">
                <div
                  className="w-full rounded-t-lg bg-emerald-700 shadow-sm shadow-emerald-950/10"
                  style={{ height }}
                  title={`${reportAxisLabel(bucket.period, mode)}: ${bucket.total} appointments`}
                />
              </div>
              <span className="mt-2 max-w-full truncate text-center text-[10px] text-slate-500">
                {reportAxisLabel(bucket.period, mode)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function VolumeChart({ stats }: { stats: AdminStats | null }) {
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
      .catch(
        (e: unknown) => active && setError(errorMessage(e, 'Failed to load the volume chart.'))
      )
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
  const visibleTotal = rates.total
  const statusTotals = useMemo(
    () =>
      SEGMENTS.map((segment) => ({
        ...segment,
        value: buckets.reduce((sum, bucket) => sum + bucket[segment.key], 0),
      })),
    [buckets]
  )
  const mostCommonStatus = useMemo(
    () => [...statusTotals].sort((a, b) => b.value - a.value)[0],
    [statusTotals]
  )
  const busiestBucket = useMemo(
    () => [...buckets].sort((a, b) => b.total - a.total)[0] ?? null,
    [buckets]
  )
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 10))

  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="card overflow-hidden">
        <div className="border-b border-emerald-100 bg-white px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <p className="section-kicker">Patient Volume</p>
              <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
                Appointment trends
              </h3>
              <p className="mt-1 max-w-2xl text-sm text-slate-500">
                Total appointments booked per period, grouped by final or current status.
              </p>
            </div>
            <div className="flex flex-col gap-2 lg:items-end">
              <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                <span className="text-xs font-medium text-slate-400" aria-live="polite">
                  {lastUpdated ? `Updated ${formatUpdated(lastUpdated)}` : 'Loading…'}
                </span>
                <button
                  type="button"
                  onClick={refresh}
                  disabled={loading}
                  title="Refresh this chart snapshot"
                  className="btn-subtle min-h-9 px-3 py-1"
                >
                  Refresh
                </button>
              </div>
              <div
                className="inline-flex flex-wrap gap-1 rounded-xl border border-emerald-100 bg-emerald-50/70 p-1"
                role="group"
                aria-label="Chart granularity"
              >
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
                    className={`min-h-8 rounded-lg px-3 py-1 text-sm font-semibold transition ${
                      granularity === g
                        ? 'bg-emerald-700 text-white shadow-sm shadow-emerald-900/20'
                        : 'text-slate-600 hover:bg-white hover:text-emerald-800'
                    }`}
                  >
                    {GRANULARITY_CONFIG[g].label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="p-4 sm:p-6">
          {error && (
            <div className="alert-error mb-4" role="alert">
              {error}
            </div>
          )}

          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {SEGMENTS.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block h-3.5 w-3.5 rounded border border-white shadow-sm ring-1 ring-slate-200"
                  style={fillStyle(s.color, s.pattern, true)}
                />
                <span className="font-medium text-slate-700">{s.label}</span>
                <span className="text-xs text-slate-400">{s.meaning}</span>
              </li>
            ))}
          </ul>

          <div className="mt-6 rounded-2xl border border-emerald-100 bg-gradient-to-b from-emerald-50/70 to-white p-3 sm:p-4">
            <div
              className="grid items-end gap-1.5"
              style={{
                minHeight: OVERVIEW_CHART_HEIGHT + 50,
                gridTemplateColumns: `repeat(${Math.max(buckets.length, 1)}, minmax(0, 1fr))`,
              }}
            >
              {loading ? (
                <p className="col-span-full self-center text-center text-sm text-slate-400">
                  Loading…
                </p>
              ) : (
                buckets.map((b, i) => {
                  const label = axisLabel(b.period, i > 0 ? buckets[i - 1].period : null, granularity)
                  const showLabel =
                    buckets.length <= 12 || i === 0 || i === buckets.length - 1 || i % labelEvery === 0
                  return (
                    <div key={b.period} className="flex min-w-0 flex-col items-center">
                      <span className="mb-1 h-4 text-[10px] font-semibold text-slate-600">
                        {b.total > 0 ? b.total : ' '}
                      </span>
                      <div
                        className="flex w-full min-w-[5px] flex-col justify-end overflow-hidden rounded-t-lg border-b border-slate-200 bg-white/80"
                        style={{ height: OVERVIEW_CHART_HEIGHT }}
                        title={`${label}: ${countLabel(b.total, 'appointment')}`}
                      >
                        {[...SEGMENTS].reverse().map((s) => {
                          const value = b[s.key]
                          if (value === 0) return null
                          const h = Math.max(3, (value / maxTotal) * OVERVIEW_CHART_HEIGHT)
                          const withPattern = h >= 22
                          return (
                            <div
                              key={s.key}
                              title={`${s.label}: ${value}`}
                              className="flex items-center justify-center overflow-hidden text-[9px] font-semibold"
                              style={{
                                height: h,
                                color: s.text,
                                ...fillStyle(s.color, s.pattern, withPattern),
                              }}
                            >
                              {h >= 16 ? value : ''}
                            </div>
                          )
                        })}
                      </div>
                      <span className="mt-2 h-7 max-w-full text-center text-[10px] leading-tight text-slate-500">
                        {showLabel ? label : ''}
                      </span>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <RateCard
              label="No-show rate"
              value={rates.noShowRate}
              count={rates.noShow}
              total={rates.total}
            />
            <RateCard
              label="Cancellation rate"
              value={rates.cancelledRate}
              count={rates.cancelled}
              total={rates.total}
            />
          </div>

          {staleCount > 0 && (
            <div className="mt-4 flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700" aria-hidden="true">
                !
              </span>
              <p>
                {staleCount} past appointment{staleCount === 1 ? '' : 's'} still marked booked —
                not yet closed out by staff.
              </p>
            </div>
          )}
        </div>
      </div>

      <KeyInsights
        stats={stats}
        visibleTotal={visibleTotal}
        rates={rates}
        staleCount={staleCount}
        busiestBucket={busiestBucket}
        mostCommonStatus={mostCommonStatus}
        granularity={granularity}
      />
    </section>
  )
}

function RateCard({
  label,
  value,
  count,
  total,
}: {
  label: string
  value: number
  count: number
  total: number
}) {
  const percent = Math.min(100, Math.max(0, value * 100))

  return (
    <div className="rounded-2xl border border-emerald-100 bg-white p-4 shadow-sm shadow-emerald-950/5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">{pct(value)}</p>
        </div>
        <p className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
          In view
        </p>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        {count} of {total} in view
      </p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-emerald-600" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

function KeyInsights({
  stats,
  visibleTotal,
  rates,
  staleCount,
  busiestBucket,
  mostCommonStatus,
  granularity,
}: {
  stats: AdminStats | null
  visibleTotal: number
  rates: ReturnType<typeof computeRates>
  staleCount: number
  busiestBucket: VolumeBucket | null
  mostCommonStatus: (typeof SEGMENTS)[number] & { value: number }
  granularity: Granularity
}) {
  const busiestLabel =
    busiestBucket && busiestBucket.total > 0
      ? axisLabel(busiestBucket.period, null, granularity)
      : null

  const insights = [
    stats ? `Appointments today: ${stats.appointmentsToday}` : null,
    stats ? `Tickets waiting today: ${stats.ticketsWaitingToday}` : null,
    `Total appointments in view: ${visibleTotal}`,
    mostCommonStatus.value > 0
      ? `Most common visible status: ${mostCommonStatus.label} (${mostCommonStatus.value})`
      : null,
    busiestLabel ? `Busiest visible period: ${busiestLabel} (${busiestBucket?.total})` : null,
    `No-show rate: ${pct(rates.noShowRate)}`,
    `Cancellation rate: ${pct(rates.cancelledRate)}`,
    staleCount > 0 ? `${countLabel(staleCount, 'past appointment')} still marked booked` : null,
  ].filter((item): item is string => Boolean(item))

  return (
    <aside className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4 shadow-sm shadow-emerald-950/5 xl:sticky xl:top-24 xl:self-start">
      <div className="rounded-xl bg-white/80 p-4 shadow-sm shadow-emerald-950/5">
        <p className="section-kicker">Key Insights</p>
        <h3 className="mt-1 text-lg font-semibold tracking-tight text-slate-950">Current view</h3>
      </div>
      <ul className="mt-4 space-y-3">
        {insights.map((insight) => (
          <li key={insight} className="flex gap-3 rounded-xl bg-white/70 p-3 text-sm text-slate-700">
            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-600 ring-4 ring-emerald-100" />
            <span>{insight}</span>
          </li>
        ))}
      </ul>
    </aside>
  )
}
