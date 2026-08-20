import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchProvidersWithAvailability,
  fetchServices,
  fetchTimeOff,
  addAvailability,
  deleteAvailability,
  addTimeOff,
  deleteTimeOff,
  previewSlots,
  generateSlots,
  fetchExceptionConflicts,
  cancelAppointment,
  type ProviderWithAvailability,
  type Service,
  type TimeOff,
  type SlotGenSummary,
  type ExceptionConflict,
} from '../../lib/api'
import { errorMessage } from '../../lib/errors'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none'

const hhmm = (t: string) => t.slice(0, 5) // 'HH:MM:SS' → 'HH:MM'

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

const todayManila = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })

function formatSlotSample(iso: string) {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function AdminProviders() {
  const [providers, setProviders] = useState<ProviderWithAvailability[]>([])
  const [services, setServices] = useState<Service[]>([])
  const [timeOff, setTimeOff] = useState<TimeOff[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadProviders = useCallback(
    () => fetchProvidersWithAvailability().then(setProviders),
    []
  )
  const loadTimeOff = useCallback(() => fetchTimeOff().then(setTimeOff), [])

  const loadAll = useCallback(
    () =>
      Promise.all([loadProviders(), fetchServices().then(setServices), loadTimeOff()])
        .then(() => setError(''))
        .catch((e: unknown) => setError(errorMessage(e, 'Failed to load provider data.')))
        .finally(() => setLoading(false)),
    [loadProviders, loadTimeOff]
  )

  useEffect(() => {
    loadAll()
  }, [loadAll])

  if (loading) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-gray-800">Providers &amp; Time Slots</h2>
        <p className="mt-4 text-gray-400">Loading…</p>
      </section>
    )
  }

  return (
    <section className="space-y-10">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">Providers &amp; Time Slots</h2>
        <p className="mt-1 text-sm text-gray-500">
          Set each provider's weekly availability, mark exception dates, then generate bookable
          slots.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      {/* 1. Providers + weekly availability */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Weekly availability
        </h3>
        {providers.map((p) => (
          <ProviderCard key={p.id} provider={p} onChanged={loadProviders} />
        ))}
      </div>

      {/* 2. Exception dates */}
      <TimeOffSection providers={providers} timeOff={timeOff} onChanged={loadTimeOff} />

      {/* 3. Slot generator */}
      <SlotGenerator providers={providers} services={services} />
    </section>
  )
}

// ── Provider card with weekly availability editor ────────────
function ProviderCard({
  provider,
  onChanged,
}: {
  provider: ProviderWithAvailability
  onChanged: () => Promise<unknown>
}) {
  const [day, setDay] = useState(1)
  const [start, setStart] = useState('08:00')
  const [end, setEnd] = useState('16:00')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const windows = useMemo(
    () =>
      [...provider.provider_availability].sort(
        (a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time)
      ),
    [provider.provider_availability]
  )

  // The unique constraint is (provider, day_of_week, start_time). Flag a
  // collision from the already-loaded windows before hitting the DB.
  const duplicate = windows.some((w) => w.day_of_week === day && hhmm(w.start_time) === start)

  const add = async () => {
    if (end <= start) {
      setError('End time must be after start time.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await addAvailability({
        providerId: provider.id,
        dayOfWeek: day,
        startTime: start,
        endTime: end,
      })
      await onChanged()
    } catch (e) {
      setError(errorMessage(e, 'Could not add availability.'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      await deleteAvailability(id)
      await onChanged()
    } catch (e) {
      setError(errorMessage(e, 'Could not remove availability.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-2">
        <p className="font-semibold text-gray-800">{provider.profiles.full_name}</p>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium capitalize text-gray-600">
          {provider.provider_type}
        </span>
        {provider.specialization && (
          <span className="text-xs text-gray-400">· {provider.specialization}</span>
        )}
      </div>

      {windows.length === 0 ? (
        <p className="mt-3 text-sm text-gray-400">No weekly availability set.</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {windows.map((w) => (
            <span
              key={w.id}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1 text-sm text-gray-700"
            >
              <span className="font-medium">{DAY_SHORT[w.day_of_week]}</span>
              {hhmm(w.start_time)}–{hhmm(w.end_time)}
              <button
                onClick={() => remove(w.id)}
                disabled={busy}
                aria-label={`Remove ${DAY_SHORT[w.day_of_week]} ${hhmm(w.start_time)}`}
                className="text-gray-400 hover:text-red-600 disabled:opacity-40"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* add window */}
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-500">
          Day
          <select
            value={day}
            onChange={(e) => setDay(Number(e.target.value))}
            className={`${inputCls} mt-1`}
          >
            {DAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-500">
          Start
          <input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className={`${inputCls} mt-1`}
          />
        </label>
        <label className="text-xs text-gray-500">
          End
          <input
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className={`${inputCls} mt-1`}
          />
        </label>
        <button
          onClick={add}
          disabled={busy || duplicate}
          className="rounded-lg border border-emerald-600 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-40"
        >
          + Add window
        </button>
      </div>

      {duplicate && (
        <p className="mt-2 text-xs text-amber-600">
          Nakatakda na ang window para sa araw at oras na ito. / This day and start time already has
          a window.
        </p>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}

// ── Exception dates (leave + clinic holidays) ────────────────
function TimeOffSection({
  providers,
  timeOff,
  onChanged,
}: {
  providers: ProviderWithAvailability[]
  timeOff: TimeOff[]
  onChanged: () => Promise<unknown>
}) {
  const [scope, setScope] = useState<string>('') // '' = clinic-wide, else provider id
  const [date, setDate] = useState(todayManila())
  const [reason, setReason] = useState('')
  const [stage, setStage] = useState<'idle' | 'confirm' | 'added'>('idle')
  const [conflicts, setConflicts] = useState<ExceptionConflict[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reset = () => {
    setStage('idle')
    setConflicts([])
    setReason('')
    setError('')
  }

  const scopeLabel = scope
    ? providers.find((p) => p.id === scope)?.profiles.full_name
    : 'all providers (clinic holiday)'

  // Step 1: run the SAME query that backs the post-commit list. If nothing is
  // affected, add straight away; otherwise pause on a confirm step so the
  // count the admin sees now equals what they act on after.
  const check = async () => {
    setBusy(true)
    setError('')
    try {
      const found = await fetchExceptionConflicts(scope || null, date)
      setConflicts(found)
      if (found.length === 0) {
        await commit()
      } else {
        setStage('confirm')
      }
    } catch (e) {
      setError(errorMessage(e, 'Could not check for affected appointments.'))
    } finally {
      setBusy(false)
    }
  }

  // Step 2: add the exception. Never cascades a delete.
  const commit = async () => {
    setBusy(true)
    setError('')
    try {
      await addTimeOff({ providerId: scope || null, exceptionDate: date, reason: reason || undefined })
      setStage('added')
      await onChanged()
    } catch (e) {
      setError(errorMessage(e, 'Could not add the exception date.'))
    } finally {
      setBusy(false)
    }
  }

  // Cancel one stranded appointment, then re-run the same query to refresh.
  const cancelOne = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      await cancelAppointment(id)
      setConflicts(await fetchExceptionConflicts(scope || null, date))
    } catch (e) {
      setError(errorMessage(e, 'Could not cancel the appointment.'))
    } finally {
      setBusy(false)
    }
  }

  const removeExisting = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      await deleteTimeOff(id)
      await onChanged()
    } catch (e) {
      setError(errorMessage(e, 'Could not remove the exception date.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Exception dates
        </h3>
        <p className="mt-1 text-sm text-gray-500">
          Days with no slots — clinic-wide holidays or a provider's leave. Remaining open slots
          stop being bookable immediately; already-booked appointments are never deleted
          automatically.
        </p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5">
        {stage === 'idle' && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-gray-500">
              Applies to
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className={`${inputCls} mt-1`}
              >
                <option value="">All providers (holiday)</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.profiles.full_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-gray-500">
              Date
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={`${inputCls} mt-1`}
              />
            </label>
            <label className="text-xs text-gray-500">
              Reason (optional)
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Araw ng Kalayaan"
                className={`${inputCls} mt-1`}
              />
            </label>
            <button
              onClick={check}
              disabled={busy}
              className="rounded-lg border border-emerald-600 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-40"
            >
              {busy ? 'Checking…' : '+ Add'}
            </button>
          </div>
        )}

        {stage === 'confirm' && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-800">
              {conflicts.length} booked appointment{conflicts.length === 1 ? '' : 's'} on {date} for{' '}
              {scopeLabel}
            </p>
            <p className="mt-1 text-xs text-amber-700">
              Adding this exception hides the remaining open slots but will NOT cancel these. You
              can cancel them after adding, or reschedule via the Reschedule feature.
            </p>
            <ConflictList conflicts={conflicts} />
            <div className="mt-3 flex gap-2">
              <button
                onClick={commit}
                disabled={busy}
                className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-40"
              >
                {busy ? 'Adding…' : 'Add exception anyway'}
              </button>
              <button
                onClick={reset}
                disabled={busy}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Back
              </button>
            </div>
          </div>
        )}

        {stage === 'added' && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm font-semibold text-emerald-800">
              Exception added for {date} · {scopeLabel}
            </p>
            {conflicts.length === 0 ? (
              <p className="mt-1 text-xs text-emerald-700">No booked appointments were affected.</p>
            ) : (
              <>
                <p className="mt-1 text-xs text-emerald-700">
                  {conflicts.length} appointment{conflicts.length === 1 ? '' : 's'} still to resolve.
                  Cancel here, or reschedule via the Reschedule feature.
                </p>
                <ConflictList conflicts={conflicts} onCancel={cancelOne} busy={busy} />
              </>
            )}
            <button
              onClick={reset}
              className="mt-3 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              Done
            </button>
          </div>
        )}

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        {timeOff.length > 0 && (
          <ul className="mt-4 divide-y divide-gray-100">
            {timeOff.map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  <span className="font-medium text-gray-800">{t.exception_date}</span>
                  <span className="ml-2 text-gray-500">
                    {t.provider_id ? t.providers?.profiles.full_name : 'All providers (holiday)'}
                  </span>
                  {t.reason && <span className="ml-2 text-gray-400">· {t.reason}</span>}
                </span>
                <button
                  onClick={() => removeExisting(t.id)}
                  disabled={busy}
                  className="text-gray-400 hover:text-red-600 disabled:opacity-40"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ConflictList({
  conflicts,
  onCancel,
  busy,
}: {
  conflicts: ExceptionConflict[]
  onCancel?: (id: string) => void
  busy?: boolean
}) {
  return (
    <ul className="mt-3 divide-y divide-black/5">
      {conflicts.map((c) => (
        <li
          key={c.appointment_id}
          className="flex items-center justify-between gap-3 py-2 text-sm"
        >
          <span className="text-gray-700">
            <span className="font-medium">{c.patient_name}</span> · {c.service_name} ·{' '}
            {c.provider_name} · {formatSlotSample(c.slot_datetime)}
            <span className="ml-1 text-xs text-gray-400">({c.status})</span>
          </span>
          {onCancel && (
            <button
              onClick={() => onCancel(c.appointment_id)}
              disabled={busy}
              className="shrink-0 rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-40"
            >
              Cancel
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

// ── Slot generator with preview → commit ─────────────────────
function SlotGenerator({
  providers,
  services,
}: {
  providers: ProviderWithAvailability[]
  services: Service[]
}) {
  const [providerId, setProviderId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [from, setFrom] = useState(() => addDays(todayManila(), 1))
  const [to, setTo] = useState(() => addDays(todayManila(), 14))
  const [intervalMin, setIntervalMin] = useState(30)
  const [preview, setPreview] = useState<SlotGenSummary | null>(null)
  const [committed, setCommitted] = useState<SlotGenSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // any input change invalidates a stale preview so you can't commit it
  const invalidate = () => {
    setPreview(null)
    setCommitted(null)
  }

  const ready = providerId && serviceId && from && to && intervalMin >= 5

  const input = { providerId, serviceId, from, to, intervalMinutes: intervalMin }

  const runPreview = async () => {
    setBusy(true)
    setError('')
    setCommitted(null)
    try {
      setPreview(await previewSlots(input))
    } catch (e) {
      setError(errorMessage(e, 'Could not preview slots.'))
    } finally {
      setBusy(false)
    }
  }

  const runGenerate = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await generateSlots(input)
      setCommitted(result)
      setPreview(null)
    } catch (e) {
      setError(errorMessage(e, 'Could not generate slots.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Generate time slots
        </h3>
        <p className="mt-1 text-sm text-gray-500">
          Expands a provider's weekly availability into bookable slots. Idempotent — existing and
          booked slots are never touched.
        </p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs text-gray-500">
            Provider
            <select
              value={providerId}
              onChange={(e) => {
                setProviderId(e.target.value)
                invalidate()
              }}
              className={`${inputCls} mt-1`}
            >
              <option value="">Select provider…</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.profiles.full_name} ({p.provider_type})
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-gray-500">
            Service
            <select
              value={serviceId}
              onChange={(e) => {
                setServiceId(e.target.value)
                invalidate()
              }}
              className={`${inputCls} mt-1`}
            >
              <option value="">Select service…</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-gray-500">
            Interval (minutes)
            <input
              type="number"
              min={5}
              max={480}
              step={5}
              value={intervalMin}
              onChange={(e) => {
                setIntervalMin(Number(e.target.value))
                invalidate()
              }}
              className={`${inputCls} mt-1`}
            />
          </label>
          <label className="text-xs text-gray-500">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value)
                invalidate()
              }}
              className={`${inputCls} mt-1`}
            />
          </label>
          <label className="text-xs text-gray-500">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value)
                invalidate()
              }}
              className={`${inputCls} mt-1`}
            />
          </label>
        </div>

        <div className="mt-4 flex gap-3">
          <button
            onClick={runPreview}
            disabled={!ready || busy}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            {busy && !preview ? 'Previewing…' : 'Preview'}
          </button>
          <button
            onClick={runGenerate}
            disabled={!preview || busy}
            title={!preview ? 'Preview first' : undefined}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            {busy && preview ? 'Generating…' : 'Generate slots'}
          </button>
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        {preview && <SummaryCard title="Preview (nothing written yet)" summary={preview} />}
        {committed && <SummaryCard title="Generated" summary={committed} success />}
      </div>
    </div>
  )
}

function SummaryCard({
  title,
  summary,
  success = false,
}: {
  title: string
  summary: SlotGenSummary
  success?: boolean
}) {
  return (
    <div
      className={`mt-4 rounded-lg border p-4 ${
        success ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-gray-50'
      }`}
    >
      <p className={`text-sm font-semibold ${success ? 'text-emerald-800' : 'text-gray-700'}`}>
        {title}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <Stat label={success ? 'Created' : 'To create'} value={summary.to_create} />
        <Stat label="Already exist" value={summary.already_exist} />
        <Stat label="Exception days" value={summary.exception_days} />
        <Stat label="Days w/ availability" value={summary.days_with_availability} />
      </div>
      {summary.sample.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            First slots
          </p>
          <p className="mt-1 text-xs text-gray-600">
            {summary.sample.map(formatSlotSample).join(' · ')}
          </p>
        </div>
      )}
      {summary.days_with_availability === 0 && (
        <p className="mt-2 text-xs text-amber-700">
          No availability windows matched this range — set weekly availability above first.
        </p>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-white px-3 py-2">
      <p className="text-lg font-bold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  )
}
