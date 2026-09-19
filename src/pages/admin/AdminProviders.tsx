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
  fetchOpenSlots,
  rescheduleAppointment,
  type OpenSlot,
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
  'form-control'

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

  const loadProviders = useCallback(() => fetchProvidersWithAvailability().then(setProviders), [])
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
        <h2 className="section-title">Providers &amp; Time Slots</h2>
        <p className="mt-4 text-slate-400">Loading…</p>
      </section>
    )
  }

  return (
    <section className="space-y-10">
      <div>
        <h2 className="section-title">Providers &amp; Time Slots</h2>
        <p className="mt-1 muted">
          Set each provider's weekly availability, mark exception dates, then generate bookable
          slots.
        </p>
      </div>

      {error && (
        <div className="alert-error" role="alert">
          {error}
        </div>
      )}

      {/* 1. Providers + weekly availability */}
      <div className="space-y-4">
        <h3 className="section-kicker">
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
    <div className="card card-pad">
      <div className="flex items-center gap-2">
        <p className="font-semibold text-slate-900">{provider.profiles.full_name}</p>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium capitalize text-slate-600">
          {provider.provider_type}
        </span>
        {provider.specialization && (
          <span className="text-xs text-slate-400">· {provider.specialization}</span>
        )}
      </div>

      {windows.length === 0 ? (
        <p className="mt-3 text-sm text-slate-400">No weekly availability set.</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {windows.map((w) => (
            <span
              key={w.id}
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50/60 px-3 py-1.5 text-sm text-slate-700"
            >
              <span className="font-medium">{DAY_SHORT[w.day_of_week]}</span>
              {hhmm(w.start_time)}–{hhmm(w.end_time)}
              <button
                onClick={() => remove(w.id)}
                disabled={busy}
                aria-label={`Remove ${DAY_SHORT[w.day_of_week]} ${hhmm(w.start_time)}`}
                className="text-slate-400 hover:text-red-600 disabled:opacity-40"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* add window */}
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="min-w-[9rem] flex-1 text-xs text-slate-500 sm:flex-none">
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
        <label className="min-w-[8rem] flex-1 text-xs text-slate-500 sm:flex-none">
          Start
          <input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className={`${inputCls} mt-1`}
          />
        </label>
        <label className="min-w-[8rem] flex-1 text-xs text-slate-500 sm:flex-none">
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
          className="btn-secondary"
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
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'success' | 'warn'>('success')

  const reset = () => {
    setStage('idle')
    setConflicts([])
    setReason('')
    setError('')
    setNotice('')
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
      await addTimeOff({
        providerId: scope || null,
        exceptionDate: date,
        reason: reason || undefined,
      })
      setStage('added')
      await onChanged()
    } catch (e) {
      setError(errorMessage(e, 'Could not add the exception date.'))
    } finally {
      setBusy(false)
    }
  }

  // Move one stranded appointment to a slot the admin picked in the dialog,
  // then re-run the same conflict query to refresh. The patient is texted.
  const rescheduleOne = async (id: string, slotId: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await rescheduleAppointment(id, slotId)
      if (result.smsNotificationFailed) {
        setNoticeKind('warn')
        setNotice('Appointment rescheduled, but the SMS notification could not be sent.')
      } else {
        setNoticeKind('success')
        setNotice(`Appointment moved to ${formatSlotSample(result.slot_datetime)}. The patient has been texted.`)
      }
      setConflicts(await fetchExceptionConflicts(scope || null, date))
    } catch (e) {
      setError(errorMessage(e, 'Could not reschedule the appointment.'))
    } finally {
      setBusy(false)
    }
  }

  // Cancel one stranded appointment, then re-run the same query to refresh.
  const cancelOne = async (id: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await cancelAppointment(id)
      if (result.smsNotificationFailed) {
        setNoticeKind('warn')
        setNotice('Appointment cancelled successfully, but the SMS notification could not be sent.')
      } else {
        setNoticeKind('success')
        setNotice('Appointment cancelled successfully.')
      }
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
        <h3 className="section-kicker">
          Exception dates
        </h3>
        <p className="mt-1 muted">
          Days with no slots — clinic-wide holidays or a provider's leave. Remaining open slots stop
          being bookable immediately; already-booked appointments are never deleted automatically.
        </p>
      </div>

      <div className="card card-pad">
        {stage === 'idle' && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[14rem] flex-1 text-xs text-slate-500">
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
            <label className="min-w-[10rem] flex-1 text-xs text-slate-500">
              Date
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={`${inputCls} mt-1`}
              />
            </label>
            <label className="min-w-[14rem] flex-1 text-xs text-slate-500">
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
              className="btn-secondary"
            >
              {busy ? 'Checking…' : '+ Add'}
            </button>
          </div>
        )}

        {stage === 'confirm' && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
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
                className="btn-primary bg-amber-600 hover:bg-amber-700"
              >
                {busy ? 'Adding…' : 'Add exception anyway'}
              </button>
              <button
                onClick={reset}
                disabled={busy}
                className="btn-secondary"
              >
                Back
              </button>
            </div>
          </div>
        )}

        {stage === 'added' && (
          <div className="alert-success">
            <p className="text-sm font-semibold text-emerald-800">
              Exception added for {date} · {scopeLabel}
            </p>
            {conflicts.length === 0 ? (
              <p
                className={`mt-1 text-xs ${
                  notice && noticeKind === 'warn' ? 'text-amber-700' : 'text-emerald-700'
                }`}
              >
                {notice || 'No booked appointments were affected.'}
              </p>
            ) : (
              <>
                <p className="mt-1 text-xs text-emerald-700">
                  {conflicts.length} appointment{conflicts.length === 1 ? '' : 's'} still to
                  resolve. Cancel here, or reschedule via the Reschedule feature.
                </p>
                {notice && (
                  <p
                    className={`mt-2 text-xs ${
                      noticeKind === 'warn' ? 'text-amber-700' : 'text-emerald-700'
                    }`}
                  >
                    {notice}
                  </p>
                )}
                <ConflictList
                  conflicts={conflicts}
                  onCancel={cancelOne}
                  onReschedule={rescheduleOne}
                  busy={busy}
                />
              </>
            )}
            <button
              onClick={reset}
              className="btn-primary mt-3"
            >
              Done
            </button>
          </div>
        )}

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        {timeOff.length > 0 && (
          <ul className="mt-4 divide-y divide-slate-100">
            {timeOff.map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  <span className="font-medium text-slate-900">{t.exception_date}</span>
                  <span className="ml-2 text-slate-500">
                    {t.provider_id ? t.providers?.profiles.full_name : 'All providers (holiday)'}
                  </span>
                  {t.reason && <span className="ml-2 text-slate-400">· {t.reason}</span>}
                </span>
                <button onClick={() => removeExisting(t.id)} disabled={busy} className="text-slate-400 hover:text-red-600 disabled:opacity-40">
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
  onReschedule,
  busy,
}: {
  conflicts: ExceptionConflict[]
  onCancel?: (id: string) => void
  onReschedule?: (id: string, slotId: string) => Promise<void>
  busy?: boolean
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  return (
    <ul className="mt-3 divide-y divide-black/5">
      {conflicts.map((c) => (
        <li key={c.appointment_id} className="py-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-gray-700">
              <span className="font-medium">{c.patient_name}</span> · {c.service_name} ·{' '}
              {c.provider_name} · {formatSlotSample(c.slot_datetime)}
              <span className="ml-1 text-xs text-slate-400">({c.status})</span>
            </span>
            <span className="flex shrink-0 gap-1">
              {onReschedule && c.status === 'booked' && (
                <button
                  onClick={() => setOpenId(openId === c.appointment_id ? null : c.appointment_id)}
                  disabled={busy}
                  className="btn-subtle min-h-8 px-2 py-1 text-xs"
                >
                  {openId === c.appointment_id ? 'Close' : 'Reschedule'}
                </button>
              )}
              {onCancel && (
                <button
                  onClick={() => onCancel(c.appointment_id)}
                  disabled={busy}
                  className="btn-danger min-h-8 px-2 py-1 text-xs"
                >
                  Cancel
                </button>
              )}
            </span>
          </div>
          {onReschedule && openId === c.appointment_id && (
            <ReschedulePicker
              conflict={c}
              busy={busy}
              onPick={async (slotId) => {
                await onReschedule(c.appointment_id, slotId)
                setOpenId(null)
              }}
            />
          )}
        </li>
      ))}
    </ul>
  )
}

// Admin picks a new date, sees that day's open slots for the SAME service
// (any provider), and confirms one. Mirrors the patient's Time step; the RPC
// re-validates everything (service match, not booked, not an exception day).
function ReschedulePicker({
  conflict,
  busy,
  onPick,
}: {
  conflict: ExceptionConflict
  busy?: boolean
  onPick: (slotId: string) => Promise<void>
}) {
  const [date, setDate] = useState(() => addDays(todayManila(), 1))
  const [slots, setSlots] = useState<OpenSlot[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<OpenSlot | null>(null)
  const [error, setError] = useState('')

  // Same shape as the booking wizard's month loader: the state writes live in
  // an async loader, not the effect body, and a stale load never lands.
  useEffect(() => {
    if (!date) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setSelected(null)
      setError('')
      try {
        const rows = await fetchOpenSlots(conflict.service_id, date)
        if (!cancelled) setSlots(rows)
      } catch (e) {
        if (!cancelled) setError(errorMessage(e, 'Could not load open slots.'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [conflict.service_id, date])

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs">
          <span className="label">New date</span>
          <input
            type="date"
            value={date}
            min={todayManila()}
            onChange={(e) => setDate(e.target.value)}
            className="form-control"
          />
        </label>
        <span className="text-xs text-slate-500">
          Open {conflict.service_name} slots on that day, any provider.
        </span>
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-2 text-xs text-slate-400">Loading open slots…</p>
      ) : slots.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">No open slots on this date. Try another day.</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {slots.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelected(s)}
              disabled={busy}
              className={`min-h-8 rounded-lg border px-2.5 py-1 text-xs ${
                selected?.id === s.id
                  ? 'border-emerald-600 bg-emerald-600 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-emerald-300'
              }`}
            >
              {formatSlotSample(s.slot_datetime)}
              <span className={`ml-1 ${selected?.id === s.id ? 'text-emerald-100' : 'text-slate-400'}`}>
                · {s.providers.profiles.full_name}
              </span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-600">
            Move <span className="font-medium">{conflict.patient_name}</span> to{' '}
            <span className="font-medium">{formatSlotSample(selected.slot_datetime)}</span> with{' '}
            {selected.providers.profiles.full_name}?
          </span>
          <button
            type="button"
            onClick={() => onPick(selected.id)}
            disabled={busy}
            className="btn-primary min-h-8 px-3 py-1 text-xs"
          >
            {busy ? 'Moving…' : 'Confirm reschedule'}
          </button>
        </div>
      )}
    </div>
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

  const providerName = providers.find((p) => p.id === providerId)?.profiles.full_name ?? ''
  const serviceName = services.find((s) => s.id === serviceId)?.name ?? ''

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
        <h3 className="section-kicker">
          Generate time slots
        </h3>
        <p className="mt-1 muted">
          Expands a provider's weekly availability into bookable slots. Idempotent — existing and
          booked slots are never touched.
        </p>
      </div>

      <div className="card card-pad">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs text-slate-500">
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
          <label className="text-xs text-slate-500">
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
          <label className="text-xs text-slate-500">
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
          <label className="text-xs text-slate-500">
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
          <label className="text-xs text-slate-500">
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
            className="btn-secondary"
          >
            {busy && !preview ? 'Previewing…' : 'Preview'}
          </button>
          <button
            onClick={runGenerate}
            disabled={!preview || busy}
            title={!preview ? 'Preview first' : undefined}
            className="btn-primary"
          >
            {busy && preview ? 'Generating…' : 'Generate slots'}
          </button>
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        {preview && <SummaryCard title="Preview (nothing written yet)" summary={preview} />}
      </div>

      {committed && (
        <GenerateResultModal
          summary={committed}
          providerName={providerName}
          serviceName={serviceName}
          from={from}
          to={to}
          onDismiss={() => setCommitted(null)}
        />
      )}
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
        success ? 'border-emerald-200 bg-emerald-50' : 'border-emerald-100 bg-emerald-50/50'
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
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">First slots</p>
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
      <p className="text-lg font-bold text-slate-950">{value}</p>
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  )
}

// Confirmation modal shown after a real (committed) generation. Reports what
// was actually written so a success is never mistaken for a no-op, and calls
// out the two "zero" cases explicitly (all slots already existed = success;
// no availability windows = fix is in provider availability, not here).
function GenerateResultModal({
  summary,
  providerName,
  serviceName,
  from,
  to,
  onDismiss,
}: {
  summary: SlotGenSummary
  providerName: string
  serviceName: string
  from: string
  to: string
  onDismiss: () => void
}) {
  const noAvailability = summary.days_with_availability === 0
  const nothingNew = !noAvailability && summary.to_create === 0
  const allExisted = nothingNew && summary.already_exist > 0
  // Warn tone for the two states that need admin attention/action; ok
  // otherwise (including "everything already existed", which is a success).
  const tone: 'ok' | 'warn' = noAvailability || (nothingNew && !allExisted) ? 'warn' : 'ok'

  let headline: string
  if (noAvailability) {
    headline = `Walang weekly availability si ${providerName} sa hanay na ito.`
  } else if (allExisted) {
    headline = 'Walang bagong slot — nakagenerate na ang lahat sa hanay na ito.'
  } else if (nothingNew) {
    headline = 'Walang na-generate na slot sa hanay na ito.'
  } else {
    headline = `${summary.to_create} bagong slot ang na-generate.`
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="genresult-title"
    >
      <div className="card w-full max-w-md p-6 shadow-xl shadow-emerald-950/15">
        <h3
          id="genresult-title"
          className={`text-base font-semibold ${
            tone === 'warn' ? 'text-amber-800' : 'text-emerald-800'
          }`}
        >
          {tone === 'warn' ? '⚠ ' : '✓ '}
          {headline}
        </h3>

        <p className="mt-2 text-sm text-slate-500">
          {serviceName} · {providerName}
          <br />
          {from} → {to}
        </p>

        {noAvailability ? (
          <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Walang availability window ang provider na ito sa alinmang araw ng linggo sa loob ng
            hanay na ito. Ayusin muna ang <span className="font-medium">Weekly availability</span>{' '}
            sa itaas — nasa provider availability ang solusyon, hindi sa generator.
            {summary.exception_days > 0 &&
              ` (${summary.exception_days} exception day${
                summary.exception_days === 1 ? '' : 's'
              } din ang nilaktawan sa hanay na ito.)`}
          </p>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
              <ModalStat label="Na-generate" value={summary.to_create} />
              <ModalStat label="Dati nang meron (nilaktawan)" value={summary.already_exist} />
              <ModalStat label="Araw na may availability" value={summary.days_with_availability} />
              <ModalStat label="Exception days (holiday/leave)" value={summary.exception_days} />
            </div>

            {allExisted && (
              <p className="mt-3 text-sm text-gray-600">
                Idempotent ang generator kaya normal ito — hindi error. Kumpleto na ang mga slot sa
                hanay na ito.
              </p>
            )}
            {nothingNew && !allExisted && (
              <p className="mt-3 text-sm text-amber-700">
                May availability windows pero walang naisulat na slot — baka mas mahaba ang interval
                kaysa sa haba ng window. Suriin ang interval at ang oras ng availability.
              </p>
            )}
            {summary.sample.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Unang mga slot
                </p>
                <p className="mt-1 text-xs text-gray-600">
                  {summary.sample.map(formatSlotSample).join(' · ')}
                </p>
              </div>
            )}
          </>
        )}

        <button
          onClick={onDismiss}
          className="mt-5 w-full rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
        >
          Isara
        </button>
      </div>
    </div>
  )
}

function ModalStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-gray-200 px-3 py-2">
      <p className="text-lg font-bold text-slate-950">{value}</p>
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  )
}
