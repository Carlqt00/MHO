import { useState, useEffect, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DashboardLayout } from '../../components/DashboardLayout'
import { TicketCard } from '../../components/TicketCard'
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
  const [smsWarning, setSmsWarning] = useState('')

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
    setSmsWarning('')
    try {
      const result = await bookAppointment(selectedSlot.id)
      setBooking(result)
      if (result.smsNotificationFailed) {
        setSmsWarning('Appointment booked successfully, but the SMS notification could not be sent.')
      }
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
          <TicketCard
            size="full"
            ticketNumber={booking.ticket_number}
            serviceName={selectedService?.name ?? ''}
            dateLabel={formatSlot(booking.slot_datetime)}
            providerName={selectedSlot?.providers.profiles.full_name ?? ''}
            qrCode={booking.qr_code}
          >
            <div className="alert-warn mt-4">
              Mangyaring dumating ng 15 minuto bago ang inyong appointment.
            </div>

            {smsWarning && (
              <div className="alert-warn mt-4" role="status">
                {smsWarning}
              </div>
            )}

            <button
              onClick={() => navigate('/patient')}
              className="btn-primary mt-6 w-full"
            >
              Bumalik sa Dashboard
            </button>
          </TicketCard>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="Book an Appointment">
      {/* Progress */}
      <div className="mb-8 flex w-full gap-2 overflow-x-auto pb-2 text-sm">
        {['Service', 'Date', 'Time', 'Confirm'].map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                step > i + 1
                  ? 'bg-emerald-700 text-white'
                  : step === i + 1
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-slate-100 text-slate-400'
              }`}
            >
              {i + 1}
            </span>
            <span className={step === i + 1 ? 'font-semibold text-slate-900' : 'text-slate-400'}>
              {label}
            </span>
            {i < 3 && <span className="text-slate-300">›</span>}
          </div>
        ))}
      </div>

      {error && (
        <div className="alert-error mb-6" role="alert">
          {error}
        </div>
      )}

      {/* ── Step 1: Service ── */}
      {step === 1 && (
        <div>
          <Link
            to="/"
            className="mb-3 inline-flex text-sm font-medium text-emerald-800 hover:text-emerald-950"
          >
            ← Back to Home
          </Link>
          <h2 className="mb-4 section-title">Choose a Service</h2>
          {servicesLoading ? (
            <p className="text-slate-400">Loading…</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {services.map((svc) => (
                <button
                  key={svc.id}
                  onClick={() => handleSelectService(svc)}
                  className="card card-interactive flex min-h-28 items-center justify-center p-6 text-center"
                >
                  <p className="text-xl font-semibold text-slate-900">{svc.name}</p>
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
              className="text-sm font-medium text-emerald-800 hover:text-emerald-950"
            >
              ← Baguhin ang serbisyo
            </button>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">
              {selectedService?.name}
            </span>
          </div>

          <h2 className="mb-4 section-title">Piliin ang petsa</h2>

          {/* Month navigation */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <button
              onClick={() => setView(addMonths(view, -1))}
              disabled={monthIndex(view) <= monthIndex(currentMonth)}
              className="btn-subtle min-h-9 px-3 py-1"
            >
              ← Nakaraan
            </button>
            <span className="text-base font-semibold text-slate-900">
              {new Date(view.year, view.month, 1).toLocaleDateString('en-PH', {
                month: 'long',
                year: 'numeric',
              })}
            </span>
            <button
              onClick={() => setView(addMonths(view, 1))}
              disabled={monthIndex(view) >= monthIndex(maxMonth)}
              className="btn-subtle min-h-9 px-3 py-1"
            >
              Susunod →
            </button>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold text-slate-500 sm:gap-2">
            {WEEKDAYS.map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>

          {/* Day grid */}
          <div className="mt-2 grid grid-cols-7 gap-1 sm:gap-2">
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
                  className={`flex min-h-16 min-w-0 flex-col items-center justify-center rounded-xl border p-1 text-center text-xs transition sm:min-h-[4.5rem] ${
                    disabled
                      ? 'cursor-not-allowed border-dashed border-slate-200 bg-slate-50 text-slate-400 line-through'
                      : 'border-emerald-100 bg-white text-slate-800 hover:border-emerald-500 hover:bg-emerald-50'
                  }`}
                >
                  <span className="text-base font-semibold">{day}</span>
                  {/* Non-color signal: available days show a count; unavailable
                      days show an explicit reason ("—" past, "Walang schedule",
                      "Puno", or "Lipas na") and are line-through. */}
                  {availLoading ? (
                    <span className="text-[10px] text-slate-300">…</span>
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
          <p className="mt-3 text-xs text-slate-500">
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
              className="text-sm font-medium text-emerald-800 hover:text-emerald-950"
            >
              ← Baguhin ang petsa
            </button>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">
              {selectedService?.name}
            </span>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700">
              {longDateLabel(selectedDate)}
            </span>
          </div>

          <h2 className="mb-4 section-title">Piliin ang oras</h2>

          {slotsLoading ? (
            <p className="text-slate-400">Hinahanap ang available na oras…</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slots.map((slot) => (
                <button
                  key={slot.id}
                  onClick={() => handleSelectSlot(slot)}
                  className="btn-subtle"
                >
                  {slotTime(slot.slot_datetime)}
                  <span className="ml-1 text-xs text-slate-400">
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
          <h2 className="mb-4 section-title">Kumpirmahin ang appointment</h2>
          <div className="card card-pad space-y-4">
            <InfoRow label="Serbisyo" value={selectedService?.name ?? ''} />
            <InfoRow label="Doktor" value={selectedSlot.providers.profiles.full_name} />
            <InfoRow label="Petsa at Oras" value={formatSlot(selectedSlot.slot_datetime)} />
          </div>

          {hasConflict && (
            <div
              className="alert-warn mt-4"
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
              className="btn-secondary"
            >
              ← Baguhin ang oras
            </button>
            <button
              onClick={handleConfirm}
              disabled={bookingBusy || hasConflict}
              className="btn-primary flex-1"
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
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-right font-medium text-slate-900">{value}</span>
    </div>
  )
}
