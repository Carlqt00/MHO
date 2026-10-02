import { useState, useEffect } from 'react'
import { AdminEmptyState, AdminPageHeader, AdminStatCard, StatusBadge } from './AdminPrimitives'
import { supabase } from '../lib/supabase'
import {
  fetchTodayQueue,
  fetchUpcomingAppointments,
  advanceQueue,
  setAppointmentStatus,
  type QueueTicket,
  type ReceptionStatus,
  type UpcomingAppointment,
} from '../lib/api'
import { errorMessage } from '../lib/errors'

interface ProviderQueue {
  providerId: string
  providerName: string
  nowServing: QueueTicket | null
  waiting: QueueTicket[]
}

function groupByProvider(tickets: QueueTicket[]): ProviderQueue[] {
  const map = new Map<string, ProviderQueue>()
  for (const t of tickets) {
    const pid = t.appointments.provider_id
    if (!map.has(pid)) {
      map.set(pid, {
        providerId: pid,
        providerName: t.appointments.providers.profiles.full_name,
        nowServing: null,
        waiting: [],
      })
    }
    const q = map.get(pid)!
    if (t.status === 'now_serving') q.nowServing = t
    else q.waiting.push(t)
  }
  // waiting already ordered by queue_position from the query
  return Array.from(map.values()).sort((a, b) => a.providerName.localeCompare(b.providerName))
}

function slotTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function slotDateKey(iso: string) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
}

function slotDateHeading(iso: string) {
  return new Date(iso).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function statusLabel(status: string) {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function groupUpcomingByDate(appointments: UpcomingAppointment[]) {
  return appointments.reduce<{ dateKey: string; dateLabel: string; appointments: UpcomingAppointment[] }[]>(
    (groups, appointment) => {
      const dateKey = slotDateKey(appointment.appointment_at)
      let group = groups.find((item) => item.dateKey === dateKey)
      if (!group) {
        group = {
          dateKey,
          dateLabel: slotDateHeading(appointment.appointment_at),
          appointments: [],
        }
        groups.push(group)
      }
      group.appointments.push(appointment)
      return groups
    },
    []
  )
}

export function QueueBoard() {
  const [tickets, setTickets] = useState<QueueTicket[]>([])
  const [upcomingAppointments, setUpcomingAppointments] = useState<UpcomingAppointment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [live, setLive] = useState(false)
  const [advancing, setAdvancing] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'success' | 'warn'>('success')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    Promise.all([fetchTodayQueue(), fetchUpcomingAppointments()])
      .then(([queueData, upcomingData]) => {
        setTickets(queueData)
        setUpcomingAppointments(upcomingData)
        setError('')
        setLoading(false)
      })
      .catch((e: unknown) => { setError(errorMessage(e, 'Failed to load the queue.')); setLoading(false) })
  }, [tick])

  useEffect(() => {
    // SIGNAL-ONLY realtime: any change to queue_tickets triggers a
    // refetch through the normal RLS-checked query. The payload is
    // never rendered directly (avoids RLS leaks — BantayBarangay pattern).
    const channel = supabase
      .channel('queue-board')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'queue_tickets' },
        () => setTick((n) => n + 1)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'appointments' },
        () => setTick((n) => n + 1)
      )
      .subscribe((status) => setLive(status === 'SUBSCRIBED'))

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const showNotice = (kind: 'success' | 'warn', text: string) => {
    setNoticeKind(kind)
    setNotice(text)
  }

  const handleAdvance = async (providerId: string) => {
    setAdvancing(providerId)
    setError('')
    setNotice('')
    try {
      const result = await advanceQueue(providerId)
      if (result?.smsNotificationFailed) {
        showNotice('warn', 'Queue advanced, but an SMS notification could not be sent.')
      } else if (result?.ticket_number) {
        showNotice('success', `Now serving ${result.ticket_number}. The patient has been texted.`)
      }
      setTick((n) => n + 1) // refetch immediately; realtime also fires
    } catch (e) {
      setError(errorMessage(e, 'Failed to advance the queue.'))
    } finally {
      setAdvancing(null)
    }
  }

  // Reception marks arrival (check-in) or absence (no-show). No-show drops the
  // ticket from the board; check-in keeps it waiting with a badge.
  const handleStatus = async (t: QueueTicket, status: ReceptionStatus) => {
    if (
      status === 'no_show' &&
      !confirm(`Mark ${t.appointments.patients.profiles.full_name} (${t.ticket_number}) as no-show?`)
    ) {
      return
    }
    setUpdatingId(t.id)
    setError('')
    setNotice('')
    try {
      const result = await setAppointmentStatus(t.appointments.id, status)
      const label = status === 'checked_in' ? 'checked in' : 'marked as no-show'
      if (result.smsNotificationFailed) {
        showNotice('warn', `${t.ticket_number} ${label}, but the SMS notification could not be sent.`)
      } else {
        showNotice('success', `${t.ticket_number} ${label}. The patient has been texted.`)
      }
      setTick((n) => n + 1)
    } catch (e) {
      setError(errorMessage(e, 'Failed to update the appointment.'))
    } finally {
      setUpdatingId(null)
    }
  }

  const queues = groupByProvider(tickets)
  const waitingCount = tickets.filter((t) => t.status !== 'now_serving').length
  const nowServingCount = tickets.filter((t) => t.status === 'now_serving').length
  const checkedInCount = tickets.filter((t) => t.appointments.status === 'checked_in').length
  const upcomingGroups = groupUpcomingByDate(upcomingAppointments)

  return (
    <div className="space-y-5">
      <AdminPageHeader
        title="Live Queue"
        subtitle="Monitor today’s queue by provider and call the next waiting ticket."
        actions={
        <span
          className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            live ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${live ? 'bg-emerald-500' : 'bg-gray-400'}`}
            aria-hidden="true"
          />
          {live ? 'Live' : 'Connecting…'}
        </span>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <AdminStatCard label="Waiting Tickets" value={loading ? <span className="text-slate-300">…</span> : waitingCount} detail="Ready to be called" />
        <AdminStatCard label="Now Serving" value={loading ? <span className="text-slate-300">…</span> : nowServingCount} detail="Active provider calls" tone="sky" />
        <AdminStatCard label="Checked In" value={loading ? <span className="text-slate-300">…</span> : checkedInCount} detail="Arrived patients waiting" tone="emerald" />
      </div>

      {error && (
        <div className="alert-error" role="alert">
          {error}
        </div>
      )}

      {notice && (
        <div className={noticeKind === 'warn' ? 'alert-warn' : 'alert-success'} role="status">
          {notice}
        </div>
      )}

      {loading ? (
        <p className="text-slate-400">Loading queue…</p>
      ) : queues.length === 0 ? (
        <AdminEmptyState>
          No tickets in today's queue.
        </AdminEmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {queues.map((q) => (
            <div key={q.providerId} className="card overflow-hidden">
              <div className="border-b border-emerald-100 bg-white px-4 py-3 sm:px-5">
                <p className="section-kicker">Provider</p>
                <p className="mt-1 break-words font-semibold text-slate-900">{q.providerName}</p>
              </div>

              <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Now Serving
                  </p>
                  {q.nowServing ? (
                    <>
                      <p className="mt-1 break-all text-3xl font-bold text-emerald-700 sm:text-4xl">
                        {q.nowServing.ticket_number}
                      </p>
                      <p className="mt-1 break-words text-sm text-slate-600">
                        {q.nowServing.appointments.patients.profiles.full_name} ·{' '}
                        {q.nowServing.appointments.services.name}
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-sm font-medium text-slate-400">No active ticket</p>
                  )}
                </div>
                <button
                  onClick={() => handleAdvance(q.providerId)}
                  disabled={advancing === q.providerId || (q.waiting.length === 0 && !q.nowServing)}
                  className="btn-primary w-full sm:w-auto"
                >
                  {advancing === q.providerId
                    ? 'Advancing…'
                    : q.nowServing
                      ? 'Done, Call Next'
                      : 'Call Next'}
                </button>
              </div>

              <div className="border-t border-emerald-100 px-4 py-3 sm:px-5">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Waiting ({q.waiting.length})
                </p>
                {q.waiting.length === 0 ? (
                  <p className="text-sm text-slate-400">Queue is empty.</p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {q.waiting.map((t) => {
                      const checkedIn = t.appointments.status === 'checked_in'
                      const busy = updatingId === t.id
                      return (
                        <li
                          key={t.id}
                          className="grid gap-2 py-2 text-sm sm:grid-cols-[3.5rem_minmax(0,1fr)_minmax(9rem,auto)_auto] sm:items-center"
                        >
                          <span className="font-mono font-semibold text-slate-700">
                            {t.ticket_number}
                          </span>
                          <span className="min-w-0 break-words text-slate-600">
                            {t.appointments.patients.profiles.full_name}
                            {checkedIn && (
                              <span className="ml-2"><StatusBadge tone="sky">Checked in</StatusBadge></span>
                            )}
                          </span>
                          <span className="min-w-0 break-words text-slate-400 sm:text-right">
                            {t.appointments.services.name} ·{' '}
                            {slotTime(t.appointments.time_slots.slot_datetime)}
                          </span>
                          <span className="flex flex-wrap gap-1 sm:flex-nowrap sm:justify-end">
                            {!checkedIn && (
                              <button
                                onClick={() => handleStatus(t, 'checked_in')}
                                disabled={busy}
                                className="btn-subtle min-h-8 px-2.5 py-1 text-xs"
                                title="Patient has arrived"
                              >
                                {busy ? '…' : 'Check in'}
                              </button>
                            )}
                            <button
                              onClick={() => handleStatus(t, 'no_show')}
                              disabled={busy}
                              className="btn-danger min-h-8 px-2.5 py-1 text-xs"
                              title="Patient did not arrive"
                            >
                              No-show
                            </button>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="rounded-2xl border border-emerald-100 bg-emerald-50/40 p-4 shadow-sm shadow-emerald-950/5 sm:p-5">
        <div>
          <p className="section-kicker">Upcoming Appointments</p>
          <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
            Upcoming Appointments
          </h3>
          <p className="mt-1 text-sm text-slate-500">Patients scheduled for upcoming dates.</p>
        </div>

        {loading ? (
          <p className="mt-4 text-slate-400">Loading upcoming appointments…</p>
        ) : upcomingAppointments.length === 0 ? (
          <div className="mt-4">
            <AdminEmptyState>No upcoming appointments.</AdminEmptyState>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {upcomingGroups.map((group) => (
              <div key={group.dateKey} className="card overflow-hidden">
                <div className="border-b border-emerald-100 bg-white px-4 py-3 sm:px-5">
                  <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-800">
                    {group.dateLabel}
                  </span>
                </div>
                <div className="divide-y divide-slate-100">
                  {group.appointments.map((appointment) => {
                    const ticket = appointment.queue_tickets
                    return (
                      <div
                        key={appointment.id}
                        className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-[1.15fr_5rem_1fr_1.2fr_auto_auto] sm:items-center sm:px-5"
                      >
                        <div className="min-w-0">
                          <p className="break-words font-semibold text-slate-900">
                            {appointment.patients.profiles.full_name}
                          </p>
                        </div>
                        <p className="font-mono text-xs font-semibold text-slate-500">
                          {ticket?.ticket_number ?? '—'}
                        </p>
                        <p className="break-words text-slate-600">{appointment.services.name}</p>
                        <p className="break-words text-slate-600">
                          {appointment.providers.profiles.full_name}
                        </p>
                        <p className="font-medium text-slate-700 sm:text-right">
                          {slotTime(appointment.appointment_at)}
                        </p>
                        <span className="sm:justify-self-end">
                          <StatusBadge tone="emerald">{statusLabel(appointment.status)}</StatusBadge>
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
