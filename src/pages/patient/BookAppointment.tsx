import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { DashboardLayout } from '../../components/DashboardLayout'
import {
  fetchServices,
  fetchOpenSlots,
  fetchServiceSlotStatus,
  fetchMyActiveBookings,
  bookAppointment,
  type Service,
  type OpenSlot,
  type BookingResult,
  type ActiveBooking,
  type DaySlotStatus,
} from '../../lib/api'

function formatSlot(iso: string) {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function slotTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Manila calendar date ('YYYY-MM-DD') of an instant. en-CA gives ISO order.
function manilaDateOf(iso: string) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
}

// Long, readable label for a 'YYYY-MM-DD' Manila date.
function longDateLabel(dateStr: string) {
  return new Date(`${dateStr}T00:00:00+08:00`).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate()

interface Month {
  year: number
  month: number // 0-based
}
const monthIndex = (m: Month) => m.year * 12 + m.month
function addMonths(m: Month, n: number): Month {
  const total = m.year * 12 + m.month + n
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 }
}

const WEEKDAYS = ['Lin', 'Lun', 'Mar', 'Miy', 'Huw', 'Biy', 'Sab'] // Sunday-start

// Why a date is not bookable, for the calendar label. Only called when there
// is nothing bookable (remaining === 0); it separates the three states the old
// single "Puno" conflated. See service_daily_slot_status (migration 0013).
function unavailableLabel(s: DaySlotStatus | undefined): string {
  if (!s || s.total === 0) return 'Walang schedule' // no slots exist that day
  if (s.upcoming > 0) return 'Puno' // upcoming slots exist but all booked
  if (s.unbooked > 0) return 'Lipas na' // open slots existed, times already passed
  return 'Puno' // all booked (and past)
}

type Step = 1 | 2 | 3 | 4

export function BookAppointment() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>(1)

  const [services, setServices] = useState<Service[]>([])
  const [servicesLoading, setServicesLoading] = useState(true)
  const [selectedService, setSelectedService] = useState<Service | null>(null)

  // Navigable window: current Manila month .. +2 months.
  const today = useMemo(
    () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }),
    []
  )
  const currentMonth = useMemo<Month>(() => {
    const [y, m] = today.split('-').map(Number)
    return { year: y, month: m - 1 }
  }, [today])
  const maxMonth = useMemo(() => addMonths(currentMonth, 2), [currentMonth])

  const [view, setView] = useState<Month>(currentMonth)
  const [availability, setAvailability] = useState<Record<string, DaySlotStatus>>({})
  const [availLoading, setAvailLoading] = useState(false)

  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [slots, setSlots] = useState<OpenSlot[]>([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState<OpenSlot | null>(null)

  const [activeBookings, setActiveBookings] = useState<ActiveBooking[]>([])

  const [booking, setBooking] = useState<BookingResult | null>(null)
  const [bookingBusy, setBookingBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchServices()
      .then(setServices)
      .catch((e: Error) => setError(e.message))
      .finally(() => setServicesLoading(false))
    // Own active bookings power the pre-submit conflict checks.
    fetchMyActiveBookings()
      .then(setActiveBookings)
      .catch(() => setActiveBookings([]))
  }, [])

  // One aggregate query per month view (not per day) whenever the service or
  // the visible month changes.
  useEffect(() => {
    if (!selectedService) return
    let cancelled = false
    const load = async () => {
      setAvailLoading(true)
      const from = `${view.year}-${pad2(view.month + 1)}-01`
      const to = `${view.year}-${pad2(view.month + 1)}-${pad2(daysInMonth(view.year, view.month))}`
      try {
        const rows = await fetchServiceSlotStatus(selectedService.id, from, to)
        if (cancelled) return
        const map: Record<string, DaySlotStatus> = {}
        for (const r of rows) map[r.day] = r
        setAvailability(map)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setAvailLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [selectedService, view.year, view.month])

  const handleSelectService = (svc: Service) => {
    setSelectedService(svc)
    setSelectedDate(null)
    setSelectedSlot(null)
    setSlots([])
    setAvailability({})
    setView(currentMonth)
    setError('')
    setStep(2)
  }

  const handleSelectDate = async (dateStr: string) => {
    setSelectedDate(dateStr)
    setSelectedSlot(null)
    setSlots([])
    setError('')
    setSlotsLoading(true)
    setStep(3)
    try {
      const data = await fetchOpenSlots(selectedService!.id, dateStr)
      setSlots(data)
      if (data.length === 0)
        setError('Wala nang available na oras sa petsang ito. Pumili ng ibang petsa.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSlotsLoading(false)
    }
  }

  const handleSelectSlot = (slot: OpenSlot) => {
    setSelectedSlot(slot)
    setError('')
    setStep(4)
  }

  // Pre-submit conflict checks — mirror the DB guards in 0011 so the patient
  // sees the conflict before hitting the database.
  const conflictSameServiceDate =
    !!selectedService &&
    !!selectedDate &&
    activeBookings.some(
      (b) => b.service_id === selectedService.id && manilaDateOf(b.slot_datetime) === selectedDate
    )
  const conflictSameTime =
    !!selectedSlot &&
    activeBookings.some(
      (b) => new Date(b.slot_datetime).getTime() === new Date(selectedSlot.slot_datetime).getTime()
    )
  const hasConflict = conflictSameServiceDate || conflictSameTime

  const handleConfirm = async () => {
    if (!selectedSlot || hasConflict) return
    setBookingBusy(true)
    setError('')
    try {
      const result = await bookAppointment(selectedSlot.id)
      setBooking(result)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBookingBusy(false)
    }
  }

  // ── Ticket (after a successful confirmation) ─────────────────
  if (booking) {
    return (
      <DashboardLayout title="Appointment Booked!">
        <div className="mx-auto max-w-md">
          <div className="rounded-2xl border-2 border-emerald-400 bg-white p-8 text-center shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-600">
              Queue Ticket
            </p>
            <p className="mt-2 text-8xl font-bold text-gray-900">{booking.ticket_number}</p>
            <p className="mt-4 text-lg font-medium text-gray-700">{selectedService?.name}</p>
            <p className="mt-1 text-gray-500">{formatSlot(booking.slot_datetime)}</p>
            <p className="mt-1 text-sm text-gray-400">
              {selectedSlot?.providers.profiles.full_name}
            </p>

            <div className="mt-6 rounded-xl bg-gray-50 px-4 py-3 text-left">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                QR Check-in Code
              </p>
              <p className="mt-1 break-all font-mono text-xs text-gray-600">{booking.qr_code}</p>
              <p className="mt-2 text-xs text-gray-500">
                I-scan ito sa reception pagdating sa MHO para mag-check in.
              </p>
            </div>

            <div className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Mangyaring dumating ng 15 minuto bago ang inyong appointment.
            </div>

            <button
              onClick={() => navigate('/patient')}
              className="mt-6 w-full rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white hover:bg-emerald-700"
            >
              Bumalik sa Dashboard
            </button>
          </div>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="Mag-book ng Appointment">
      {/* Progress */}
      <div className="mb-8 flex items-center gap-2 text-sm">
        {['Serbisyo', 'Petsa', 'Oras', 'Kumpirma'].map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                step > i + 1
                  ? 'bg-emerald-600 text-white'
                  : step === i + 1
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-gray-100 text-gray-400'
              }`}
            >
              {i + 1}
            </span>
            <span className={step === i + 1 ? 'font-semibold text-gray-800' : 'text-gray-400'}>
              {label}
            </span>
            {i < 3 && <span className="text-gray-300">›</span>}
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      {/* ── Step 1: Service ── */}
      {step === 1 && (
        <div>
          <h2 className="mb-4 text-lg font-semibold text-gray-800">Piliin ang serbisyo</h2>
          {servicesLoading ? (
            <p className="text-gray-400">Loading…</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {services.map((svc) => (
                <button
                  key={svc.id}
                  onClick={() => handleSelectService(svc)}
                  className="rounded-xl border-2 border-gray-200 bg-white p-5 text-left transition-colors hover:border-emerald-400 hover:bg-emerald-50"
                >
                  <p className="text-lg font-semibold text-gray-800">{svc.name}</p>
                  {svc.description && (
                    <p className="mt-1 text-sm text-gray-500">{svc.description}</p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Step 2: Date (calendar) ── */}
      {step === 2 && (
        <div>
          <div className="mb-4 flex items-center gap-3">
            <button
              onClick={() => {
                setStep(1)
                setError('')
              }}
              className="text-sm text-emerald-700 hover:underline"
            >
              ← Baguhin ang serbisyo
            </button>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">
              {selectedService?.name}
            </span>
          </div>

          <h2 className="mb-4 text-lg font-semibold text-gray-800">Piliin ang petsa</h2>

          {/* Month navigation */}
          <div className="mb-3 flex items-center justify-between">
            <button
              onClick={() => setView(addMonths(view, -1))}
              disabled={monthIndex(view) <= monthIndex(currentMonth)}
              className="rounded-lg border border-gray-300 px-3 py-1 text-sm text-gray-700 enabled:hover:bg-gray-50 disabled:opacity-40"
            >
              ← Nakaraan
            </button>
            <span className="text-base font-semibold text-gray-800">
              {new Date(view.year, view.month, 1).toLocaleDateString('en-PH', {
                month: 'long',
                year: 'numeric',
              })}
            </span>
            <button
              onClick={() => setView(addMonths(view, 1))}
              disabled={monthIndex(view) >= monthIndex(maxMonth)}
              className="rounded-lg border border-gray-300 px-3 py-1 text-sm text-gray-700 enabled:hover:bg-gray-50 disabled:opacity-40"
            >
              Susunod →
            </button>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 gap-2 text-center text-xs font-semibold text-gray-500">
            {WEEKDAYS.map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>

          {/* Day grid */}
          <div className="mt-2 grid grid-cols-7 gap-2">
            {/* leading blanks so day 1 lands on its weekday */}
            {Array.from({ length: new Date(view.year, view.month, 1).getDay() }).map((_, i) => (
              <div key={`blank-${i}`} />
            ))}
            {Array.from({ length: daysInMonth(view.year, view.month) }).map((_, i) => {
              const day = i + 1
              const dateStr = `${view.year}-${pad2(view.month + 1)}-${pad2(day)}`
              const isPast = dateStr < today
              const status = availability[dateStr]
              const remaining = status?.remaining ?? 0
              const disabled = isPast || remaining === 0
              return (
                <button
                  key={dateStr}
                  onClick={() => handleSelectDate(dateStr)}
                  disabled={disabled}
                  aria-disabled={disabled}
                  className={`flex min-h-[4.5rem] flex-col items-center justify-center rounded-lg border p-1 text-center ${
                    disabled
                      ? 'cursor-not-allowed border-dashed border-gray-200 bg-gray-50 text-gray-400 line-through'
                      : 'border-gray-300 bg-white text-gray-800 hover:border-emerald-500 hover:bg-emerald-50'
                  }`}
                >
                  <span className="text-base font-semibold">{day}</span>
                  {/* Non-color signal: available days show a count; unavailable
                      days show an explicit reason ("—" past, "Walang schedule",
                      "Puno", or "Lipas na") and are line-through. */}
                  {availLoading ? (
                    <span className="text-[10px] text-gray-300">…</span>
                  ) : isPast ? (
                    <span className="text-[10px]">—</span>
                  ) : remaining > 0 ? (
                    <span className="text-[11px]">
                      {remaining} slot{remaining === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className="text-[10px] leading-tight">{unavailableLabel(status)}</span>
                  )}
                </button>
              )
            })}
          </div>
          <p className="mt-3 text-xs text-gray-400">
            Naka-disable ang mga araw na hindi mai-book: <span className="font-medium">“—”</span>{' '}
            nakaraang petsa · <span className="font-medium">“Walang schedule”</span> walang oras na
            binuksan para sa serbisyong ito · <span className="font-medium">“Puno”</span> puno na
            ang lahat ng slot · <span className="font-medium">“Lipas na”</span> may bakante kanina
            pero lumipas na ang oras ngayong araw.
          </p>
        </div>
      )}

      {/* ── Step 3: Time ── */}
      {step === 3 && selectedDate && (
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <button
              onClick={() => {
                setStep(2)
                setSelectedSlot(null)
                setError('')
              }}
              className="text-sm text-emerald-700 hover:underline"
            >
              ← Baguhin ang petsa
            </button>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">
              {selectedService?.name}
            </span>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-700">
              {longDateLabel(selectedDate)}
            </span>
          </div>

          <h2 className="mb-4 text-lg font-semibold text-gray-800">Piliin ang oras</h2>

          {slotsLoading ? (
            <p className="text-gray-400">Hinahanap ang available na oras…</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slots.map((slot) => (
                <button
                  key={slot.id}
                  onClick={() => handleSelectSlot(slot)}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-emerald-500 hover:bg-emerald-50"
                >
                  {slotTime(slot.slot_datetime)}
                  <span className="ml-1 text-xs text-gray-400">
                    · {slot.providers.profiles.full_name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Step 4: Confirm ── */}
      {step === 4 && selectedSlot && (
        <div className="mx-auto max-w-md">
          <h2 className="mb-4 text-lg font-semibold text-gray-800">Kumpirmahin ang appointment</h2>
          <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-6">
            <InfoRow label="Serbisyo" value={selectedService?.name ?? ''} />
            <InfoRow label="Doktor" value={selectedSlot.providers.profiles.full_name} />
            <InfoRow label="Petsa at Oras" value={formatSlot(selectedSlot.slot_datetime)} />
          </div>

          {hasConflict && (
            <div
              className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800"
              role="alert"
            >
              {conflictSameServiceDate
                ? 'May booking ka na para sa serbisyong ito sa petsang ito. Pumili ng ibang petsa o serbisyo. / You already have a booking for this service on this date.'
                : 'May booking ka na sa oras na ito. Pumili ng ibang oras. / You already have a booking at this time.'}
            </div>
          )}

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button
              onClick={() => {
                setStep(3)
                setSelectedSlot(null)
                setError('')
              }}
              className="rounded-xl border border-gray-300 px-6 py-3 font-medium text-gray-700 hover:bg-gray-50"
            >
              ← Baguhin ang oras
            </button>
            <button
              onClick={handleConfirm}
              disabled={bookingBusy || hasConflict}
              className="flex-1 rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {bookingBusy ? 'Nag-bo-book…' : 'I-confirm ang Appointment'}
            </button>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-800">{value}</span>
    </div>
  )
}
