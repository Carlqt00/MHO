import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { DashboardLayout } from '../../components/DashboardLayout'
import { AnnouncementsFeed } from '../../components/AnnouncementsFeed'
import { fetchMyAppointments, cancelAppointment, type Appointment } from '../../lib/api'

function formatSlot(iso: string) {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const STATUS_LABEL: Record<string, string> = {
  booked: 'Booked',
  checked_in: 'Naka-check in',
  served: 'Tapos na',
  cancelled: 'Cancelled',
  no_show: 'Hindi dumating',
}

const STATUS_COLOR: Record<string, string> = {
  booked: 'bg-emerald-100 text-emerald-800',
  checked_in: 'bg-blue-100 text-blue-800',
  served: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-600',
  no_show: 'bg-orange-100 text-orange-700',
}

export function PatientDashboard() {
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const [tick, setTick] = useState(0)
  // setLoading called from event handler (not inside effect) so the rule is satisfied
  const reload = () => { setLoading(true); setTick((n) => n + 1) }

  useEffect(() => {
    fetchMyAppointments()
      .then((data) => { setAppointments(data); setLoading(false) })
      .catch((e: Error) => { setError(e.message); setLoading(false) })
  }, [tick])

  const handleCancel = async (id: string) => {
    if (!confirm('Sigurado ka bang gusto mong i-cancel ang appointment na ito?')) return
    setCancellingId(id)
    try {
      await cancelAppointment(id)
      reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCancellingId(null)
    }
  }

  return (
    <DashboardLayout title="Patient Dashboard">
      <div className="mb-6">
        <Link
          to="/patient/book"
          className="inline-block rounded-xl bg-emerald-600 px-6 py-3 text-lg font-semibold text-white hover:bg-emerald-700"
        >
          + Mag-book ng Appointment
        </Link>
      </div>

      <h2 className="mb-4 text-lg font-semibold text-gray-800">Aking mga Appointment</h2>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <p className="text-gray-400">Loading…</p>
      ) : appointments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
          <p className="text-lg font-medium">Wala pang appointment.</p>
          <p className="mt-1 text-sm">I-click ang "Mag-book" para magsimula.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {appointments.map((appt) => {
            const ticket = appt.queue_tickets[0]
            return (
              <div
                key={appt.id}
                className="flex flex-col gap-4 rounded-xl border border-gray-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-gray-800">{appt.services.name}</p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[appt.status] ?? 'bg-gray-100 text-gray-600'}`}
                    >
                      {STATUS_LABEL[appt.status] ?? appt.status}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500">
                    {appt.providers.profiles.full_name} ·{' '}
                    {formatSlot(appt.time_slots.slot_datetime)}
                  </p>
                  {ticket && (
                    <p className="text-sm font-medium text-emerald-700">
                      Ticket: {ticket.ticket_number} · Queue #{ticket.queue_position}
                    </p>
                  )}
                </div>

                {appt.status === 'booked' && (
                  <button
                    onClick={() => handleCancel(appt.id)}
                    disabled={cancellingId === appt.id}
                    className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    {cancellingId === appt.id ? 'Cancelling…' : 'I-cancel'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <AnnouncementsFeed />
    </DashboardLayout>
  )
}
