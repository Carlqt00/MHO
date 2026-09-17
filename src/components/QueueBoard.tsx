import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { fetchTodayQueue, advanceQueue, type QueueTicket } from '../lib/api'
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

export function QueueBoard() {
  const [tickets, setTickets] = useState<QueueTicket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [live, setLive] = useState(false)
  const [advancing, setAdvancing] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    fetchTodayQueue()
      .then((data) => { setTickets(data); setError(''); setLoading(false) })
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
      .subscribe((status) => setLive(status === 'SUBSCRIBED'))

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const handleAdvance = async (providerId: string) => {
    setAdvancing(providerId)
    setError('')
    try {
      await advanceQueue(providerId)
      setTick((n) => n + 1) // refetch immediately; realtime also fires
    } catch (e) {
      setError(errorMessage(e, 'Failed to advance the queue.'))
    } finally {
      setAdvancing(null)
    }
  }

  const queues = groupByProvider(tickets)

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="section-title">Today's Queue</h2>
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
      </div>

      {error && (
        <div className="alert-error mb-4" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-slate-400">Loading queue…</p>
      ) : queues.length === 0 ? (
        <div className="empty-state">
          No tickets in the queue today.
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {queues.map((q) => (
            <div key={q.providerId} className="card overflow-hidden">
              <div className="border-b border-emerald-100 px-5 py-4">
                <p className="font-semibold text-slate-900">{q.providerName}</p>
              </div>

              <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Now Serving
                  </p>
                  {q.nowServing ? (
                    <>
                      <p className="text-5xl font-bold text-emerald-700">
                        {q.nowServing.ticket_number}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        {q.nowServing.appointments.patients.profiles.full_name} ·{' '}
                        {q.nowServing.appointments.services.name}
                      </p>
                    </>
                  ) : (
                    <p className="text-5xl font-bold text-slate-300">—</p>
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

              <div className="border-t border-emerald-100 px-5 py-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Waiting ({q.waiting.length})
                </p>
                {q.waiting.length === 0 ? (
                  <p className="text-sm text-slate-400">Queue is empty.</p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {q.waiting.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <span className="font-mono font-semibold text-slate-700">
                          {t.ticket_number}
                        </span>
                        <span className="text-slate-600">
                          {t.appointments.patients.profiles.full_name}
                        </span>
                        <span className="text-slate-400">
                          {t.appointments.services.name} ·{' '}
                          {slotTime(t.appointments.time_slots.slot_datetime)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
