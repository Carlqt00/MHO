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
  served: 'Done',
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
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'success' | 'warn'>('success')
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
          className="btn-primary w-full sm:w-auto"
        >
          + Book an Appointment
        </Link>
      </div>

      <h2 className="mb-4 section-title">My Appointments</h2>

      {error && (
        <div className="alert-error mb-4">{error}</div>
      )}

      {notice && (
        <div className={`${noticeKind === 'warn' ? 'alert-warn' : 'alert-success'} mb-4`} role="status">
          {notice}
        </div>
      )}

      {loading ? (
        <p className="text-slate-400">Loading…</p>
      ) : appointments.length === 0 ? (
        <div className="empty-state">
          <p className="text-lg font-medium">Wala pang appointment.</p>
          <p className="mt-1 text-sm">Click "Book an Appointment" to get started.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {appointments.map((appt) => {
            const ticket = appt.queue_tickets
            return (
              <div
                key={appt.id}
                className="card card-pad flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-900">{appt.services.name}</p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[appt.status] ?? 'bg-gray-100 text-gray-600'}`}
                    >
                      {STATUS_LABEL[appt.status] ?? appt.status}
                    </span>
                  </div>
                  <p className="text-sm text-slate-500">
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
                    className="btn-danger w-full sm:w-auto"
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
