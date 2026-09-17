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

  return (
    <section className="card card-pad mt-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Patient Volume</h3>
          <p className="text-sm text-slate-500">
            Total appointments booked per period, by what became of them.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <span className="text-xs text-slate-400" aria-live="polite">
              {lastUpdated ? `Updated ${formatUpdated(lastUpdated)}` : 'Loading…'}
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              title="Refresh — this chart is a snapshot, not a live feed"
              className="btn-subtle min-h-9 px-3 py-1"
            >
              ↻ Refresh
            </button>
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Chart granularity">
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
                    ? 'border-emerald-800 bg-emerald-800 text-white'
                    : 'border-emerald-200 bg-white text-slate-700 hover:bg-emerald-50'
                }`}
              >
                {GRANULARITY_CONFIG[g].label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="alert-error mt-4" role="alert">
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
            <span className="text-slate-700">
              {s.label} <span className="text-slate-400">({s.meaning})</span>
            </span>
          </li>
        ))}
      </ul>

      {/* Chart. Empty periods still render as zero-height bars (not gaps). */}
      <div className="mt-4 overflow-x-auto">
        <div className="flex min-w-[42rem] items-end gap-1" style={{ height: CHART_HEIGHT + 48 }}>
          {loading ? (
            <p className="self-center text-sm text-slate-400">Loading…</p>
          ) : (
            buckets.map((b, i) => (
              <div key={b.period} className="flex min-w-[18px] flex-1 flex-col items-center">
                {/* Total above the bar — omitted for empty periods; the nbsp keeps
                    the row height uniform so all bar baselines still line up. */}
                <span className="mb-0.5 text-[10px] font-medium text-slate-600">
                  {b.total > 0 ? b.total : ' '}
                </span>
                <div
                  className="flex w-full flex-col justify-end border-b border-slate-200"
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
                        style={{
                          height: h,
                          color: s.text,
                          ...fillStyle(s.color, s.pattern, withPattern),
                        }}
                      >
                        {h >= 14 ? value : ''}
                      </div>
                    )
                  })}
                </div>
                {/* Day mode packs 30 bars — rotate labels so every day-of-month
                    stays readable without truncating. Coarser modes have room to
                    sit flat. */}
                {granularity === 'day' ? (
                  <div className="mt-1 flex h-7 w-full justify-center">
                    <span className="origin-top -rotate-45 whitespace-nowrap text-[9px] leading-none text-slate-500">
                      {axisLabel(b.period, i > 0 ? buckets[i - 1].period : null, granularity)}
                    </span>
                  </div>
                ) : (
                  <span className="mt-1 w-full whitespace-nowrap text-center text-[9px] text-slate-500">
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
        <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-3">
          <p className="text-sm text-slate-500">No-show rate</p>
          <p className="text-2xl font-bold text-slate-950">{pct(rates.noShowRate)}</p>
          <p className="text-xs text-slate-400">
            {rates.noShow} of {rates.total} in view
          </p>
        </div>
        <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-3">
          <p className="text-sm text-slate-500">Cancellation rate</p>
          <p className="text-2xl font-bold text-slate-950">{pct(rates.cancelledRate)}</p>
          <p className="text-xs text-slate-400">
            {rates.cancelled} of {rates.total} in view
          </p>
        </div>
      </div>

      {/* Stale-booked note. NOT auto-reclassified — surfaced for staff. */}
      {staleCount > 0 && (
        <p className="alert-warn mt-3">
          ⚠ {staleCount} past appointment{staleCount === 1 ? '' : 's'} still marked booked — not yet
          closed out by staff.
        </p>
      )}
    </section>
  )
}
