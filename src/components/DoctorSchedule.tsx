import { useEffect, useMemo, useState } from 'react'
import { fetchDoctorAppointments, type DoctorAppointment } from '../lib/api'

const pad2 = (n: number) => String(n).padStart(2, '0')
const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate()

interface Month {
  year: number
  month: number // 0-based
}
function addMonths(m: Month, n: number): Month {
  const total = m.year * 12 + m.month + n
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 }
}

// One Asia/Manila calendar month as a UTC ISO window.
function manilaMonthWindow(m: Month): { start: string; end: string } {
  const mm = pad2(m.month + 1)
  const last = pad2(daysInMonth(m.year, m.month))
  return {
    start: new Date(`${m.year}-${mm}-01T00:00:00+08:00`).toISOString(),
    end: new Date(`${m.year}-${mm}-${last}T23:59:59.999+08:00`).toISOString(),
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}
function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const STATUS_LABEL: Record<string, string> = {
  booked: 'Booked',
  checked_in: 'Checked in',
  served: 'Served',
  cancelled: 'Cancelled',
  no_show: 'No show',
}
const STATUS_COLOR: Record<string, string> = {
  booked: 'bg-emerald-100 text-emerald-800',
  checked_in: 'bg-blue-100 text-blue-800',
  served: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-600',
  no_show: 'bg-orange-100 text-orange-700',
}

export function DoctorSchedule() {
  const currentMonth = useMemo<Month>(() => {
    const [y, m] = new Date()
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
      .split('-')
      .map(Number)
    return { year: y, month: m - 1 }
  }, [])

  const [view, setView] = useState<Month>(currentMonth)
  const [appointments, setAppointments] = useState<DoctorAppointment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      const { start, end } = manilaMonthWindow(view)
      try {
        const data = await fetchDoctorAppointments(start, end)
        if (cancelled) return
        // Sort by date then time (slot_datetime ascending).
        const sorted = [...data].sort(
          (a, b) =>
            new Date(a.time_slots.slot_datetime).getTime() -
            new Date(b.time_slots.slot_datetime).getTime()
        )
        setAppointments(sorted)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [view])

  // Active = what the doctor acts on; History = finished business. The two
  // sets are disjoint and cover every status. `appointments` is already sorted
  // by date then time, and filtering preserves that order.
  const { active, history } = useMemo(() => {
    const active = appointments.filter((a) => a.status === 'booked' || a.status === 'checked_in')
    const history = appointments.filter(
      (a) => a.status === 'served' || a.status === 'no_show' || a.status === 'cancelled'
    )
    return { active, history }
  }, [appointments])

  const monthLabel = new Date(view.year, view.month, 1).toLocaleDateString('en-PH', {
    month: 'long',
    year: 'numeric',
  })

  return (
    <div className="card card-pad">
      {/* One month control drives both sections. */}
      <div className="mb-6 flex flex-wrap items-center justify-center gap-3 sm:justify-end">
        <button
          onClick={() => setView(addMonths(view, -1))}
          className="btn-subtle min-h-9 px-3 py-1"
        >
          ← Prev
        </button>
        <span className="order-first w-full text-center text-base font-semibold text-slate-900 sm:order-none sm:w-auto sm:min-w-[9rem]">
          {monthLabel}
        </span>
        <button
          onClick={() => setView(addMonths(view, 1))}
          className="btn-subtle min-h-9 px-3 py-1"
        >
          Next →
        </button>
      </div>

      {error && (
        <div className="alert-error mb-4">{error}</div>
      )}

      {loading ? (
        <p className="text-slate-400">Loading…</p>
      ) : (
        <div className="space-y-8">
          <ScheduleSection
            title="My Schedule"
            rows={active}
            emptyMessage="Walang aktibong appointment sa buwang ito. / No active appointments this month."
          />
          <ScheduleSection
            title="History"
            rows={history}
            emptyMessage="Walang natapos na appointment sa buwang ito. / No finished appointments this month."
          />
        </div>
      )}
    </div>
  )
}

function ScheduleSection({
  title,
  rows,
  emptyMessage,
}: {
  title: string
  rows: DoctorAppointment[]
  emptyMessage: string
}) {
  return (
    <section>
      <h3 className="mb-3 text-base font-semibold text-slate-900">{title}</h3>
      {rows.length === 0 ? (
        <div className="empty-state">
          {emptyMessage}
        </div>
      ) : (
        <div className="table-shell">
          <table className="data-table mobile-card-table lg:min-w-[44rem]">
            <thead>
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Patient</th>
                <th className="px-3 py-2 font-medium">Contact</th>
                <th className="px-3 py-2 font-medium">Service</th>
                <th className="px-3 py-2 font-medium">Ticket</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((appt) => {
                const profile = appt.patients?.profiles
                return (
                  <tr key={appt.id} className="text-slate-700">
                    <td data-label="Date" className="px-3 py-2 whitespace-nowrap">
                      {formatDate(appt.time_slots.slot_datetime)}
                    </td>
                    <td data-label="Time" className="px-3 py-2 whitespace-nowrap">
                      {formatTime(appt.time_slots.slot_datetime)}
                    </td>
                    <td data-label="Patient" className="px-3 py-2">{profile?.full_name ?? '—'}</td>
                    <td data-label="Contact" className="px-3 py-2 whitespace-nowrap">{profile?.phone ?? '—'}</td>
                    <td data-label="Service" className="px-3 py-2">{appt.services.name}</td>
                    <td data-label="Ticket" className="px-3 py-2 whitespace-nowrap">
                      {appt.queue_tickets?.ticket_number ?? '—'}
                    </td>
                    <td data-label="Status" className="px-3 py-2">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[appt.status] ?? 'bg-gray-100 text-gray-600'}`}
                      >
                        {STATUS_LABEL[appt.status] ?? appt.status}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
