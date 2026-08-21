import { useEffect, useMemo, useState } from 'react'
import { DashboardLayout } from '../../components/DashboardLayout'
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

// "Current" = an active (not served/cancelled/no_show) booking. Of those, the
// one happening soonest is the patient's current booking.
const ACTIVE_STATUSES = new Set(['booked', 'checked_in'])

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

  // Soonest active booking = current booking; everything else is history.
  const { current, history } = useMemo(() => {
    const active = appointments
      .filter((a) => ACTIVE_STATUSES.has(a.status))
      .sort(
        (a, b) =>
          new Date(a.time_slots.slot_datetime).getTime() -
          new Date(b.time_slots.slot_datetime).getTime()
      )
    const current = active[0] ?? null

    const history = appointments
      .filter((a) => a.id !== current?.id)
      .sort(
        (a, b) =>
          new Date(b.time_slots.slot_datetime).getTime() -
          new Date(a.time_slots.slot_datetime).getTime()
      )

    return { current, history }
  }, [appointments])

  return (
    <DashboardLayout title="Profile">
      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <p className="text-gray-400">Loading…</p>
      ) : (
        <div className="space-y-8">
          {/* 1. Basic profile info (read-only) */}
          <section className="rounded-xl border border-gray-200 bg-white p-6">
            <h2 className="mb-4 text-lg font-semibold text-gray-800">Basic Info</h2>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Name</dt>
                <dd className="mt-1 text-gray-800">{profile?.full_name || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Email</dt>
                <dd className="mt-1 text-gray-800">{profile?.email || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Phone</dt>
                <dd className="mt-1 text-gray-800">{profile?.phone || '—'}</dd>
              </div>
            </dl>
          </section>

          {/* 2. Current booking with its queue number */}
          <section>
            <h2 className="mb-4 text-lg font-semibold text-gray-800">Current Booking</h2>
            {current ? (
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-gray-800">{current.services.name}</p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[current.status] ?? 'bg-gray-100 text-gray-600'}`}
                  >
                    {STATUS_LABEL[current.status] ?? current.status}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-500">
                  {current.providers.profiles.full_name} ·{' '}
                  {formatSlot(current.time_slots.slot_datetime)}
                </p>
                {current.queue_tickets[0] && (
                  <p className="mt-2 text-sm font-medium text-emerald-700">
                    Ticket: {current.queue_tickets[0].ticket_number} · Queue #
                    {current.queue_tickets[0].queue_position}
                  </p>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
                Wala kang kasalukuyang booking. / You have no current booking.
              </div>
            )}
          </section>

          {/* 3. Appointment history — all statuses, most recent first */}
          <section>
            <h2 className="mb-4 text-lg font-semibold text-gray-800">Appointment History</h2>
            {history.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
                Wala ka pang nakaraang appointment. / You have no past appointments yet.
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">Date</th>
                      <th className="px-4 py-3 font-medium">Service</th>
                      <th className="px-4 py-3 font-medium">Provider</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {history.map((appt) => (
                      <tr key={appt.id}>
                        <td className="px-4 py-3 text-gray-700">
                          {formatDate(appt.time_slots.slot_datetime)}
                        </td>
                        <td className="px-4 py-3 text-gray-700">{appt.services.name}</td>
                        <td className="px-4 py-3 text-gray-700">
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
