import { useState, useEffect, useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { DashboardLayout } from '../../components/DashboardLayout'
import { TicketCard } from '../../components/TicketCard'
import {
  fetchServices,
  fetchOpenSlots,
  fetchServiceSlotStatus,
  fetchMyActiveBookings,
  fetchMyAppointments,
  bookAppointment,
  rescheduleAppointment,
  type Service,
  type OpenSlot,
  type BookingResult,
  type ActiveBooking,
  type DaySlotStatus,
  type Appointment,
} from '../../lib/api'

function formatSlot(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
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
  return new Date(iso).toLocaleTimeString('en-US', {
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
  return new Date(`${dateStr}T00:00:00+08:00`).toLocaleDateString('en-US', {
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

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] // Sunday-start

// Why a date is not bookable, for the calendar label. Only called when there
// is nothing bookable (remaining === 0); it separates the three states the old
// single "Puno" conflated. See service_daily_slot_status (migration 0013).
function unavailableLabel(s: DaySlotStatus | undefined): string {
  if (!s || s.total === 0) return 'No schedule' // no slots exist that day
  if (s.is_full) return 'Full' // service/day capacity has been reached
  if (s.upcoming > 0) return 'Full' // generated upcoming slots exist, but none are open
  if (s.unbooked > 0) return 'Past times' // open slots existed, times already passed
  return 'Full' // all generated slots are booked
}

type Step = 1 | 2 | 3 | 4

// The same wizard serves two flows:
//   /patient/book                  — new booking (all four steps)
//   /patient/book?reschedule=<id>  — move an existing BOOKED appointment. The
//     service is fixed to the appointment's, so step 1 is skipped, and confirm
//     calls reschedule_appointment instead of book_appointment.
export function BookAppointment() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const rescheduleId = searchParams.get('reschedule')
  const isReschedule = !!rescheduleId
  const [rescheduling, setRescheduling] = useState<Appointment | null>(null)
  const [rescheduleLoading, setRescheduleLoading] = useState(isReschedule)

  const [step, setStep] = useState<Step>(isReschedule ? 2 : 1)

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

  // Reschedule: load the appointment being moved and pin the service to it.
  useEffect(() => {
    if (!rescheduleId) return
    let cancelled = false
    fetchMyAppointments()
      .then((list) => {
        if (cancelled) return
        const appt = list.find((a) => a.id === rescheduleId)
        if (!appt) {
          setError('Hindi mahanap ang appointment. / Appointment not found.')
        } else if (appt.status !== 'booked') {
          setError(
            'Hindi na maaaring ilipat ang appointment na ito. / This appointment can no longer be rescheduled.'
          )
        } else {
          setRescheduling(appt)
          setSelectedService({ id: appt.service_id, name: appt.services.name, description: null })
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setRescheduleLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [rescheduleId])

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
        setError('No available times remain on this date. Choose another date.')
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
  // sees the conflict before hitting the database. When rescheduling, the
  // appointment being moved is not a conflict with itself.
  const otherBookings = rescheduleId
    ? activeBookings.filter((b) => b.id !== rescheduleId)
    : activeBookings
  const conflictSameServiceDate =
    !!selectedService &&
    !!selectedDate &&
    otherBookings.some(
      (b) => b.service_id === selectedService.id && manilaDateOf(b.slot_datetime) === selectedDate
    )
  const conflictSameTime =
    !!selectedSlot &&
    otherBookings.some(
      (b) => new Date(b.slot_datetime).getTime() === new Date(selectedSlot.slot_datetime).getTime()
    )
  const hasConflict = conflictSameServiceDate || conflictSameTime

  const handleConfirm = async () => {
    if (!selectedSlot || hasConflict) return
    setBookingBusy(true)
    setError('')
    setSmsWarning('')
    try {
      if (rescheduling) {
        const result = await rescheduleAppointment(rescheduling.id, selectedSlot.id)
        setBooking({
          appointment_id: result.appointment_id,
          ticket_number: result.ticket_number,
          queue_position: result.queue_position,
          qr_code: result.qr_code,
          slot_datetime: result.slot_datetime,
          smsNotificationFailed: result.smsNotificationFailed,
        })
        if (result.smsNotificationFailed) {
          setSmsWarning('Appointment moved successfully, but the SMS notification could not be sent.')
        }
      } else {
        const result = await bookAppointment(selectedSlot.id)
        setBooking(result)
        if (result.smsNotificationFailed) {
          setSmsWarning('Appointment booked successfully, but the SMS notification could not be sent.')
        }
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
      <DashboardLayout title={isReschedule ? 'Nailipat ang Appointment!' : 'Appointment Booked!'}>
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
              Please arrive 15 minutes before your appointment.
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
              Back to Dashboard
            </button>
          </TicketCard>
        </div>
      </DashboardLayout>
    )
  }

  // Reschedule flow is blocked until the appointment loads (or fails to).
  if (isReschedule && (rescheduleLoading || !rescheduling)) {
    return (
      <DashboardLayout title="Ilipat ang Appointment">
        {rescheduleLoading ? (
          <p className="text-slate-400">Loading…</p>
        ) : (
          <div className="mx-auto max-w-md">
            <div className="alert-error" role="alert">
              {error || 'Hindi mahanap ang appointment. / Appointment not found.'}
            </div>
            <Link to="/patient" className="btn-secondary mt-4 inline-flex">
              ← Bumalik sa Dashboard
            </Link>
          </div>
        )}
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title={isReschedule ? 'Ilipat ang Appointment' : 'Book an Appointment'}>
      {rescheduling && (
        <div className="alert-warn mb-6" role="status">
          Kasalukuyang iskedyul: <strong>{rescheduling.services.name}</strong> ·{' '}
          {rescheduling.providers.profiles.full_name} ·{' '}
          {formatSlot(rescheduling.time_slots.slot_datetime)}. Pumili ng bagong petsa at oras.
        </div>
      )}

      {/* Progress */}
      <div className="mb-8 grid w-full grid-cols-4 gap-1 text-xs sm:gap-2 sm:text-sm">
        {['Service', 'Date', 'Time', 'Confirm'].map((label, i) => (
          <div key={label} className="flex min-w-0 items-center justify-center gap-1 sm:gap-2">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                step > i + 1
                  ? 'bg-emerald-700 text-white'
                  : step === i + 1
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-slate-100 text-slate-400'
              }`}
            >
              {i + 1}
            </span>
            <span className={`min-w-0 truncate ${step === i + 1 ? 'font-semibold text-slate-900' : 'text-slate-400'}`}>
              {label}
            </span>
            {i < 3 && <span className="hidden text-slate-300 sm:inline">›</span>}
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
            to="/patient"
            className="mb-3 inline-flex text-sm font-medium text-emerald-800 hover:text-emerald-950"
          >
            ← Back to Dashboard
          </Link>
          <h2 className="mb-4 section-title">Choose a Service</h2>
          {servicesLoading ? (
            <p className="text-slate-400">Loading…</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4">
              {services.map((svc) => (
                <button
                  key={svc.id}
                  onClick={() => handleSelectService(svc)}
                  className="card card-interactive flex min-h-24 items-center justify-center p-4 text-center sm:min-h-28 sm:p-6"
                >
                  <p className="text-lg font-semibold text-slate-900 sm:text-xl">{svc.name}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Step 2: Date (calendar) ── */}
      {step === 2 && (
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            {isReschedule ? (
              <Link
                to="/patient"
                className="text-sm font-medium text-emerald-800 hover:text-emerald-950"
              >
                ← Back to Dashboard
              </Link>
            ) : (
              <button
                onClick={() => {
                  setStep(1)
                  setError('')
                }}
                className="text-sm font-medium text-emerald-800 hover:text-emerald-950"
              >
                ← Change Service
              </button>
            )}
            <span className="max-w-full break-words rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">
              {selectedService?.name}
            </span>
          </div>

          <h2 className="mb-4 section-title">Choose a Date</h2>

          {/* Month navigation */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <button
              onClick={() => setView(addMonths(view, -1))}
              disabled={monthIndex(view) <= monthIndex(currentMonth)}
              className="btn-subtle min-h-9 px-3 py-1"
            >
              ← Previous
            </button>
            <span className="order-first w-full text-center text-base font-semibold text-slate-900 sm:order-none sm:w-auto">
              {new Date(view.year, view.month, 1).toLocaleDateString('en-US', {
                month: 'long',
                year: 'numeric',
              })}
            </span>
            <button
              onClick={() => setView(addMonths(view, 1))}
              disabled={monthIndex(view) >= monthIndex(maxMonth)}
              className="btn-subtle min-h-9 px-3 py-1"
            >
              Next →
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
              const remaining = status?.remaining_slots ?? status?.remaining ?? 0
              const hasSchedule = Boolean(status && status.total > 0)
              const hasOpenTimeSlot = (status?.open_slots ?? 0) > 0
              const disabled = isPast || !hasSchedule || status?.is_full || !hasOpenTimeSlot
              return (
                <button
                  key={dateStr}
                  onClick={() => handleSelectDate(dateStr)}
                  disabled={disabled}
                  aria-disabled={disabled}
                  className={`flex min-h-14 min-w-0 flex-col items-center justify-center rounded-xl border p-1 text-center text-[10px] leading-tight transition sm:min-h-[4.5rem] sm:text-xs ${
                    disabled
                      ? 'cursor-not-allowed border-dashed border-slate-200 bg-slate-50 text-slate-400 line-through'
                      : 'border-emerald-100 bg-white text-slate-800 hover:border-emerald-500 hover:bg-emerald-50'
                  }`}
                >
                  <span className="text-sm font-semibold sm:text-base">{day}</span>
                  {/* Non-color signal: available days show service capacity
                      remaining; unavailable days show an explicit reason. */}
                  {availLoading ? (
                    <span className="text-[10px] text-slate-300">…</span>
                  ) : isPast ? (
                    <span className="text-[10px]">—</span>
                  ) : !disabled && remaining > 0 ? (
                    <span className="text-[10px] sm:text-[11px]">
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
            Disabled dates: <span className="font-medium">“—”</span> past date ·{' '}
            <span className="font-medium">“No schedule”</span> no generated time slots for this
            service · <span className="font-medium">“Full”</span> service capacity or generated time
            slots are full · <span className="font-medium">“Past times”</span> open times existed
            earlier today but have already passed.
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
              ← Change Date
            </button>
            <span className="max-w-full break-words rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">
              {selectedService?.name}
            </span>
            <span className="max-w-full break-words rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700">
              {longDateLabel(selectedDate)}
            </span>
          </div>

          <h2 className="mb-4 section-title">Choose a Time</h2>

          {slotsLoading ? (
            <p className="text-slate-400">Finding available times…</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-2">
              {slots.map((slot) => (
                <button
                  key={slot.id}
                  onClick={() => handleSelectSlot(slot)}
                  className="btn-subtle w-full flex-wrap gap-1"
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
          <h2 className="mb-4 section-title">Confirm Appointment</h2>
          <div className="card card-pad space-y-4">
            <InfoRow label="Service" value={selectedService?.name ?? ''} />
            <InfoRow label="Provider" value={selectedSlot.providers.profiles.full_name} />
            <InfoRow label="Date and Time" value={formatSlot(selectedSlot.slot_datetime)} />
          </div>

          {hasConflict && (
            <div
              className="alert-warn mt-4"
              role="alert"
            >
              {conflictSameServiceDate
                ? 'You already have a booking for this service on this date. Choose another date or service.'
                : 'You already have a booking at this time. Choose another time.'}
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
              ← Change Time
            </button>
            <button
              onClick={handleConfirm}
              disabled={bookingBusy || hasConflict}
              className="btn-primary flex-1"
            >
              {bookingBusy
                ? isReschedule
                  ? 'Rescheduling…'
                  : 'Booking…'
                : isReschedule
                  ? 'Confirm New Time'
                  : 'Confirm Appointment'}
            </button>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 text-sm min-[420px]:flex-row min-[420px]:justify-between min-[420px]:gap-4">
      <span className="text-slate-500">{label}</span>
      <span className="break-words font-medium text-slate-900 min-[420px]:text-right">{value}</span>
    </div>
  )
}
