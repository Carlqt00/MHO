import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { DashboardLayout } from '../../components/DashboardLayout'
import { TicketCard } from '../../components/TicketCard'
import { useAuth } from '../../hooks/useAuth'
import {
  fetchMyProfile,
  fetchMyAppointmentHistory,
  type PatientProfile as PatientProfileData,
  type Appointment,
} from '../../lib/api'

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

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
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

// Current booking = business that isn't finished yet (booked, plus checked_in
// once the patient has arrived). History = finished business only. These two
// sets are disjoint and cover every status, so nothing overlaps or disappears.
const CURRENT_STATUSES = new Set(['booked', 'checked_in'])
const HISTORY_STATUSES = new Set(['served', 'no_show', 'cancelled'])

export function PatientProfile() {
  const { session } = useAuth()
  const userId = session?.userId

  const [profile, setProfile] = useState<PatientProfileData | null>(null)
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!userId) return
    Promise.all([fetchMyProfile(userId), fetchMyAppointmentHistory()])
      .then(([p, appts]) => {
        setProfile(p)
        setAppointments(appts)
        setLoading(false)
      })
      .catch((e: Error) => {
        setError(e.message)
        setLoading(false)
      })
  }, [userId])

  const { current, history } = useMemo(() => {
    const current = appointments
      .filter((a) => CURRENT_STATUSES.has(a.status))
      .sort(
        (a, b) =>
          new Date(a.time_slots.slot_datetime).getTime() -
          new Date(b.time_slots.slot_datetime).getTime()
      ) // soonest first

    const history = appointments
      .filter((a) => HISTORY_STATUSES.has(a.status))
      .sort(
        (a, b) =>
          new Date(b.time_slots.slot_datetime).getTime() -
          new Date(a.time_slots.slot_datetime).getTime()
      ) // most recent first

    return { current, history }
  }, [appointments])

  return (
    <DashboardLayout title="Profile">
      <div className="mb-6">
        <Link to="/patient" className="text-sm font-medium text-emerald-800 hover:text-emerald-950">
          ← Back to Dashboard
        </Link>
      </div>

      {error && (
        <div className="alert-error mb-4">{error}</div>
      )}

      {loading ? (
        <p className="text-slate-400">Loading…</p>
      ) : (
        <div className="space-y-8">
          {/* 1. Basic profile info (read-only) */}
          <section className="card card-pad">
            <div className="mb-4">
              <h2 className="section-title">Basic Info</h2>
            </div>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Name</dt>
                <dd className="mt-1 text-slate-800">{profile?.full_name || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Email</dt>
                <dd className="mt-1 break-all text-slate-800">{profile?.email || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Phone</dt>
                <dd className="mt-1 text-slate-800">{profile?.phone || '—'}</dd>
              </div>
            </dl>
          </section>

          {/* 2. Current booking(s) with queue number + QR check-in code */}
          <section>
            <h2 className="mb-4 section-title">Current Booking</h2>
            {current.length === 0 ? (
              <div className="empty-state">
                Wala kang kasalukuyang booking. / You have no current booking.
              </div>
            ) : (
              <div className="space-y-4">
                {current.map((appt) => (
                  <CurrentBookingCard key={appt.id} appt={appt} />
                ))}
              </div>
            )}
          </section>

          {/* 3. Appointment history — finished business only, most recent first */}
          <section>
            <h2 className="mb-4 section-title">Appointment History</h2>
            {history.length === 0 ? (
              <div className="empty-state">
                Wala ka pang nakaraang appointment. / You have no past appointments yet.
              </div>
            ) : (
              <div className="table-shell">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="px-4 py-3 font-medium">Date</th>
                      <th className="px-4 py-3 font-medium">Service</th>
                      <th className="px-4 py-3 font-medium">Provider</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((appt) => (
                      <tr key={appt.id}>
                        <td className="text-slate-700">
                          {formatDate(appt.time_slots.slot_datetime)}
                        </td>
                        <td className="text-slate-700">{appt.services.name}</td>
                        <td className="text-slate-700">
                          {appt.providers.profiles.full_name}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[appt.status] ?? 'bg-gray-100 text-gray-600'}`}
                          >
                            {STATUS_LABEL[appt.status] ?? appt.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </DashboardLayout>
  )
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[status] ?? 'bg-gray-100 text-gray-600'}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

function CurrentBookingCard({ appt }: { appt: Appointment }) {
  // Same source the confirmation screen uses (queue_tickets, created at
  // booking). The fetch normalizes the embed to a single object (or null).
  const ticket = appt.queue_tickets

  // Ticket present: echo the confirmation screen's ticket, compact.
  if (ticket) {
    return (
      <TicketCard
        size="compact"
        ticketNumber={ticket.ticket_number}
        serviceName={appt.services.name}
        dateLabel={formatSlot(appt.time_slots.slot_datetime)}
        providerName={appt.providers.profiles.full_name}
        qrCode={ticket.qr_code}
        status={<StatusBadge status={appt.status} />}
      />
    )
  }

  // Tickets are issued at booking, so a missing ticket is an anomaly — degrade
  // to the appointment details with a note rather than crash or show nothing.
  return (
    <div className="card card-pad">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-slate-900">{appt.services.name}</p>
        <StatusBadge status={appt.status} />
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {appt.providers.profiles.full_name} · {formatSlot(appt.time_slots.slot_datetime)}
      </p>
      <p className="mt-2 text-sm text-slate-500">
        Wala pang queue number na naitalaga. Ipakita ang booking na ito sa reception ng MHO. / No
        queue number assigned yet — please show this booking at the MHO reception.
      </p>
    </div>
  )
}
