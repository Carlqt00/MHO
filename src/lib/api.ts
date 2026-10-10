import { supabase } from './supabase'
import { errorMessage } from './errors'
import { toCanonicalPhilippineMobile } from './phone'
import type { Role } from './auth'
import type { VolumeBucket } from './volume'

const GENERIC_ERR =
  'May problema sa koneksyon. Pakisubukan ulit. / Something went wrong - please try again.'

export interface Service {
  id: string
  name: string
  description: string | null
}

export interface OpenSlot {
  id: string
  slot_datetime: string
  duration_minutes: number
  providers: {
    id: string
    specialization: string | null
    profiles: { full_name: string }
  }
  services: { id: string; name: string }
}

export interface BookingResult {
  appointment_id: string
  ticket_number: string
  queue_position: number
  qr_code: string
  slot_datetime: string
  smsNotificationFailed?: boolean
}

export interface Appointment {
  id: string
  status: string
  service_id: string
  services: { name: string }
  providers: { profiles: { full_name: string } }
  time_slots: { slot_datetime: string }
  appointment_reschedule_proposals?: {
    id: string
    status: string
    proposed_appointment_at: string
    reason: string
    token_expires_at: string
  }[]
  // queue_tickets.appointment_id is UNIQUE, so PostgREST treats this as a
  // to-ONE relationship and embeds it as a single object (or null) — NOT an
  // array. (The confirmation screen sidesteps this by reading the ticket from
  // the book_appointment RPC return instead of an embed.)
  queue_tickets: {
    ticket_number: string
    queue_position: number
    qr_code: string
    status: string
  } | null
}

// PostgREST embeds queue_tickets as a single object here (its appointment_id
// FK is UNIQUE → a to-one relationship). But relationship detection is
// config/version dependent, and a to-many embed would arrive as an array
// instead. Normalize either shape to one ticket (or null) so consumers never
// have to guess — this is the fix for the "queue number missing" bug, where
// the object was being indexed as if it were an array.
function normalizeTicket(qt: unknown): Appointment['queue_tickets'] {
  if (Array.isArray(qt)) return (qt[0] as Appointment['queue_tickets']) ?? null
  return (qt as Appointment['queue_tickets']) ?? null
}

function normalizeAppointments(rows: unknown[]): Appointment[] {
  return (rows as Appointment[]).map((row) => ({
    ...row,
    queue_tickets: normalizeTicket(row.queue_tickets),
  }))
}

export async function fetchServices(): Promise<Service[]> {
  const { data, error } = await supabase
    .from('services')
    .select('id, name, description')
    .eq('active', true)
    .order('name')

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return data as Service[]
}

// A single Asia/Manila calendar day as a UTC ISO window.
function manilaDayWindowFor(manilaDate: string): { start: string; end: string } {
  return {
    start: new Date(`${manilaDate}T00:00:00+08:00`).toISOString(),
    end: new Date(`${manilaDate}T23:59:59.999+08:00`).toISOString(),
  }
}

// Individual open slots for a service. When manilaDate ('YYYY-MM-DD') is given,
// restricts to that Manila calendar day — used by the Time step. Always keeps
// the future-only filter so past times today never appear.
export async function fetchOpenSlots(serviceId: string, manilaDate?: string): Promise<OpenSlot[]> {
  // open_slots (0009) is a view over time_slots that already excludes booked
  // slots AND slots on an exception date (leave / clinic holiday), via the
  // shared is_exception_slot predicate. Same embeds work — it projects
  // time_slots 1:1.
  let query = supabase
    .from('open_slots')
    .select(
      `
      id, slot_datetime, duration_minutes,
      providers!inner ( id, specialization, profiles!inner ( full_name ) ),
      services!inner ( id, name )
    `
    )
    .eq('service_id', serviceId)
    .gte('slot_datetime', new Date().toISOString())

  if (manilaDate) {
    const { start, end } = manilaDayWindowFor(manilaDate)
    query = query.gte('slot_datetime', start).lte('slot_datetime', end)
  }

  const { data, error } = await query.order('slot_datetime').limit(100)

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return data as unknown as OpenSlot[]
}

export async function fetchOpenSlotsForProvider(
  serviceId: string,
  providerId: string,
  manilaDate?: string
): Promise<OpenSlot[]> {
  const slots = await fetchOpenSlots(serviceId, manilaDate)
  return slots.filter((slot) => slot.providers.id === providerId)
}

export interface DaySlotStatus {
  day: string // 'YYYY-MM-DD' (Asia/Manila)
  remaining: number // actually bookable: min(service capacity remaining, open_slots)
  unbooked: number // unbooked, any time (past + upcoming)
  upcoming: number // any slot with slot_datetime >= now() (booked or not)
  total: number // every non-exception slot that day (booked + unbooked)
  daily_capacity: number
  booked_count: number
  remaining_slots: number // same as remaining; explicit RPC field for clarity
  is_full: boolean // true when service/day capacity is exhausted
  open_slots: number // unbooked AND upcoming generated time slots
}

// ONE aggregate query for the month calendar (service_daily_slot_status):
// per-Manila-day schedule counts plus fixed service-capacity counts. from/to
// are inclusive Manila dates ('YYYY-MM-DD'). Days with NO non-exception slot are
// absent from the result, so the calendar reads them as "No schedule".
export async function fetchServiceSlotStatus(
  serviceId: string,
  from: string,
  to: string
): Promise<DaySlotStatus[]> {
  const { data, error } = await supabase.rpc('service_daily_slot_status', {
    p_service_id: serviceId,
    p_from: from,
    p_to: to,
  })
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return (data ?? []) as DaySlotStatus[]
}

export interface ActiveBooking {
  id: string
  service_id: string
  slot_datetime: string
  duration_minutes: number
}

// The caller's own active bookings, for client-side conflict
// pre-checks before submit. RLS scopes this to the current patient.
export async function fetchMyActiveBookings(): Promise<ActiveBooking[]> {
  const { data, error } = await supabase
    .from('appointments')
    .select('id, service_id, appointment_duration_minutes, time_slots!inner ( slot_datetime )')
    .in('status', ['booked', 'checked_in'])

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return (
    (data ?? []) as unknown as {
      id: string
      service_id: string
      appointment_duration_minutes: number
      time_slots: { slot_datetime: string }
    }[]
  ).map((row) => ({
    id: row.id,
    service_id: row.service_id,
    slot_datetime: row.time_slots.slot_datetime,
    duration_minutes: row.appointment_duration_minutes,
  }))
}

export async function bookAppointment(slotId: string): Promise<BookingResult> {
  const { data, error } = await supabase.rpc('book_appointment', { p_slot_id: slotId })
  if (error) {
    const raw = (error as { message?: string }).message ?? ''
    // The slot became unavailable after the patient loaded the list — the
    // patient did nothing wrong, so reassure and point them to another slot.
    if (raw.includes('ERR_ON_EXCEPTION_DATE')) {
      throw new Error(
        'Paumanhin, hindi na available ang oras na ito — maaaring may holiday o na-adjust ang schedule ng provider. Pumili po ng ibang slot. / Sorry, this time is no longer available — please choose another slot.'
      )
    }
    if (raw.includes('ERR_ALREADY_BOOKED')) {
      throw new Error(
        'Nakuha na po ng iba ang slot na ito. Pumili po ng ibang oras. / This slot was just taken — please choose another time.'
      )
    }
    if (raw.includes('ERR_SERVICE_FULL')) {
      throw new Error('No slots remaining for this service on the selected date.')
    }
    if (raw.includes('ERR_PATIENT_OVERLAP')) {
      throw new Error(
        'You already have another appointment that overlaps with this time. Please choose a different time.'
      )
    }
    throw new Error(errorMessage(error, GENERIC_ERR))
  }
  const booking = data as BookingResult
  const sms = await trySendAppointmentSms('appointment_booked', booking.appointment_id)
  return { ...booking, smsNotificationFailed: !sms.success }
}

export interface SmsNotificationAttempt {
  smsNotificationFailed: boolean
}

export async function cancelAppointment(appointmentId: string): Promise<SmsNotificationAttempt> {
  const { error } = await supabase.rpc('cancel_appointment', { p_appointment_id: appointmentId })
  if (error) {
    const raw = (error as { message?: string }).message ?? ''
    if (raw.includes('ERR_INVALID_STATUS'))
      throw new Error(
        'Hindi na maaaring i-cancel ang appointment na ito. / This appointment can no longer be cancelled.'
      )
    if (raw.includes('ERR_FORBIDDEN'))
      throw new Error(
        'Wala kang pahintulot na i-cancel ang appointment na ito. / You are not allowed to cancel this appointment.'
      )
    if (raw.includes('ERR_NOT_FOUND'))
      throw new Error('Hindi mahanap ang appointment. / Appointment not found.')
    throw new Error(errorMessage(error, GENERIC_ERR))
  }
  const sms = await trySendAppointmentSms('appointment_cancelled', appointmentId)
  return { smsNotificationFailed: !sms.success }
}

export interface RescheduleResult {
  appointment_id: string
  previous_slot_datetime: string
  slot_datetime: string
  provider_id: string
  ticket_number: string
  queue_position: number
  qr_code: string
  smsNotificationFailed?: boolean
}

// Move a booked appointment to another open slot of the SAME service
// (reschedule_appointment RPC, migration 0021). Patient for their own booking,
// or staff/admin for anyone. The RPC swaps the slots race-safely and re-issues
// the queue ticket when the provider/day changes; then the patient is texted.
export async function rescheduleAppointment(
  appointmentId: string,
  newSlotId: string
): Promise<RescheduleResult> {
  const { data, error } = await supabase.rpc('reschedule_appointment', {
    p_appointment_id: appointmentId,
    p_new_slot_id: newSlotId,
  })
  if (error) {
    const raw = (error as { message?: string }).message ?? ''
    if (raw.includes('ERR_ALREADY_BOOKED'))
      throw new Error(
        'Nakuha na po ng iba ang slot na ito. Pumili po ng ibang oras. / This slot was just taken — please choose another time.'
      )
    if (raw.includes('ERR_ON_EXCEPTION_DATE'))
      throw new Error(
        'Paumanhin, hindi na available ang oras na ito — maaaring may holiday o na-adjust ang schedule ng provider. Pumili po ng ibang slot. / Sorry, this time is no longer available — please choose another slot.'
      )
    if (raw.includes('ERR_INVALID_STATUS'))
      throw new Error(
        'Hindi na maaaring ilipat ang appointment na ito. / This appointment can no longer be rescheduled.'
      )
    if (raw.includes('ERR_SERVICE_MISMATCH'))
      throw new Error(
        'Ibang serbisyo ang napiling oras. / The chosen time is for a different service.'
      )
    if (raw.includes('ERR_SLOT_PAST'))
      throw new Error('Lipas na ang oras na ito. / That time has already passed.')
    if (raw.includes('ERR_SAME_SLOT'))
      throw new Error('Ito na ang kasalukuyang oras ng appointment. / That is already the current time.')
    if (raw.includes('ERR_PATIENT_OVERLAP'))
      throw new Error(
        'You already have another appointment that overlaps with this time. Please choose a different time.'
      )
    if (raw.includes('ERR_FORBIDDEN'))
      throw new Error(
        'Wala kang pahintulot na ilipat ang appointment na ito. / You are not allowed to reschedule this appointment.'
      )
    if (raw.includes('ERR_NOT_FOUND'))
      throw new Error('Hindi mahanap ang appointment o oras. / Appointment or slot not found.')
    throw new Error(errorMessage(error, GENERIC_ERR))
  }
  const result = data as RescheduleResult
  const sms = await trySendAppointmentSms('appointment_rescheduled', appointmentId)
  return { ...result, smsNotificationFailed: !sms.success }
}

export type ReceptionStatus = 'checked_in' | 'no_show'

// Reception marks a patient as arrived (checked_in) or absent (no_show) —
// set_appointment_status RPC (0021), nurse/staff/admin only. Texts the patient.
export async function setAppointmentStatus(
  appointmentId: string,
  status: ReceptionStatus
): Promise<SmsNotificationAttempt> {
  const { data, error } = await supabase.rpc('set_appointment_status', {
    p_appointment_id: appointmentId,
    p_status: status,
  })
  if (error) {
    const raw = (error as { message?: string }).message ?? ''
    if (raw.includes('ERR_INVALID_STATUS'))
      throw new Error('This appointment is not in a state that allows that change.')
    if (raw.includes('ERR_FORBIDDEN'))
      throw new Error('Only clinic personnel can update appointment status.')
    if (raw.includes('ERR_NOT_FOUND')) throw new Error('Appointment not found.')
    throw new Error(errorMessage(error, GENERIC_ERR))
  }
  const result = data as { appointment_status?: string; reason?: string } | null
  if (result?.reason === 'missed_checkin_deadline') {
    throw new Error(
      'This appointment was automatically cancelled because the 15-minute check-in deadline has passed.'
    )
  }
  const sms = await trySendAppointmentSms(
    status === 'checked_in' ? 'appointment_checked_in' : 'appointment_no_show',
    appointmentId
  )
  return { smsNotificationFailed: !sms.success }
}

export type AppointmentSmsEvent =
  | 'appointment_booked'
  | 'appointment_cancelled'
  | 'appointment_rescheduled'
  | 'appointment_checked_in'
  | 'appointment_served'
  | 'appointment_no_show'
  | 'appointment_auto_cancelled_missed_checkin'
  | 'queue_now_serving'

export interface AppointmentSmsResult {
  success: boolean
  notification_log_id?: string
  http_status?: number
  response?: unknown
}

export async function sendAppointmentSms(
  event: AppointmentSmsEvent,
  appointmentId: string
): Promise<AppointmentSmsResult> {
  const { data, error } = await supabase.functions.invoke('send-sms', {
    body: { event, appointment_id: appointmentId },
  })
  if (error) {
    let message = ''
    const context = (error as { context?: unknown }).context
    if (context instanceof Response) {
      try {
        const parsed = await context.json()
        if (parsed && typeof parsed.error === 'string') message = parsed.error
      } catch {
        // Keep the safe generic fallback below.
      }
    }
    throw new Error(message || errorMessage(error, 'SMS notification could not be sent.'))
  }
  return data as AppointmentSmsResult
}

export interface RescheduleProposalRequest {
  appointment_id: string
  proposed_slot_id: string
}

export interface SendRescheduleProposalsResult {
  success: boolean
  sent: {
    proposal_id: string
    appointment_id: string
    patient_name: string
    proposed_appointment_at: string
    notification_log_id: string
  }[]
  failed: { appointment_id?: string; proposed_slot_id?: string; proposal_id?: string; error: string }[]
}

export interface PublicRescheduleProposal {
  proposal_id: string
  status: string
  effective_status: string
  service_name: string
  provider_name: string
  original_appointment_at: string
  proposed_appointment_at: string
  reason: string
  token_expires_at: string
  responded_at: string | null
}

export interface RescheduleProposalResponseResult {
  proposal_id: string
  appointment_id: string
  patient_id: string
  patient_phone: string | null
  service_name: string
  proposed_appointment_at: string
  status: 'accepted' | 'declined'
}

async function callRescheduleProposalFunction<T>(body: Record<string, unknown>): Promise<T> {
  const publicAction = body.action === 'lookup' || body.action === 'respond'
  if (publicAction) {
    const response = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/reschedule-proposal`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(body),
      }
    )
    const parsed = (await response.json().catch(() => null)) as
      | { error?: string; message?: string }
      | T
      | null
    if (!response.ok) {
      const message =
        parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string'
          ? parsed.error
          : parsed &&
              typeof parsed === 'object' &&
              'message' in parsed &&
              typeof parsed.message === 'string'
            ? parsed.message
          : GENERIC_ERR
      throw new Error(message)
    }
    return parsed as T
  }

  const { data, error } = await supabase.functions.invoke('reschedule-proposal', { body })
  if (error) {
    let message = ''
    const context = (error as { context?: unknown }).context
    if (context instanceof Response) {
      try {
        const parsed = await context.json()
        if (parsed && typeof parsed.error === 'string') message = parsed.error
      } catch {
        // Keep generic fallback.
      }
    }
    throw new Error(message || errorMessage(error, GENERIC_ERR))
  }
  return data as T
}

export function sendEmergencyRescheduleProposals(input: {
  reason: string
  proposals: RescheduleProposalRequest[]
  expiresHours?: number
}): Promise<SendRescheduleProposalsResult> {
  return callRescheduleProposalFunction<SendRescheduleProposalsResult>({
    action: 'create',
    reason: input.reason,
    proposals: input.proposals,
    expires_hours: input.expiresHours ?? 24,
  })
}

export function resendEmergencyRescheduleProposal(
  proposalId: string
): Promise<{ success: boolean; sent: SendRescheduleProposalsResult['sent'][number] }> {
  return callRescheduleProposalFunction({
    action: 'resend',
    proposal_id: proposalId,
  })
}

export async function fetchPublicRescheduleProposal(
  token: string
): Promise<PublicRescheduleProposal> {
  const result = await callRescheduleProposalFunction<{ proposal: PublicRescheduleProposal }>({
    action: 'lookup',
    token,
  })
  return result.proposal
}

export async function fetchPublicRescheduleProposalByCode(
  code: string
): Promise<PublicRescheduleProposal> {
  const result = await callRescheduleProposalFunction<{ proposal: PublicRescheduleProposal }>({
    action: 'lookup',
    code,
  })
  return result.proposal
}

export async function respondToRescheduleProposal(
  token: string,
  response: 'accepted' | 'declined'
): Promise<RescheduleProposalResponseResult> {
  const result = await callRescheduleProposalFunction<{ result: RescheduleProposalResponseResult }>({
    action: 'respond',
    token,
    response,
  })
  return result.result
}

export async function respondToRescheduleProposalByCode(
  code: string,
  response: 'accepted' | 'declined'
): Promise<RescheduleProposalResponseResult> {
  const result = await callRescheduleProposalFunction<{ result: RescheduleProposalResponseResult }>(
    {
      action: 'respond',
      code,
      response,
    }
  )
  return result.result
}

// 'sent' = accepted/transmitted by the gateway; 'delivered' = handset receipt
// confirmed via the itextmo-webhook (migration 0021).
export type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed'
export type NotificationType = 'sms' | 'email'

export interface NotificationLog {
  id: string
  type: NotificationType
  event: string | null
  recipient: string
  message: string
  status: NotificationStatus
  created_at: string
  sent_at: string | null
  error_message: string | null
}

export interface NotificationSummary {
  sent: number
  delivered: number
  pending: number
  failed: number
}

export interface SmsInboxMessage {
  id: string
  provider_message_id: string | null
  sender: string
  message: string
  received_at: string
  is_read: boolean
  created_at: string
}

export interface SmsConversationMessage {
  id: string
  direction: 'inbound' | 'outbound'
  phone: string
  message: string
  created_at: string
  status?: NotificationStatus
}

export async function fetchNotificationLogs(
  status: NotificationStatus | 'all' = 'all'
): Promise<NotificationLog[]> {
  let query = supabase
    .from('notification_logs')
    .select('id, type, event, recipient, message, status, created_at, sent_at, error_message')
    .order('created_at', { ascending: false })
    .limit(100)

  if (status !== 'all') query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw new Error(errorMessage(error, 'Failed to load notification logs.'))
  return data as NotificationLog[]
}

export async function fetchNotificationSummary(): Promise<NotificationSummary> {
  const countOf = (status: NotificationStatus) =>
    supabase.from('notification_logs').select('id', { count: 'exact', head: true }).eq('status', status)

  const [sent, delivered, pending, failed] = await Promise.all([
    countOf('sent'),
    countOf('delivered'),
    countOf('pending'),
    countOf('failed'),
  ])

  for (const result of [sent, delivered, pending, failed]) {
    if (result.error) throw new Error(errorMessage(result.error, 'Failed to load notification totals.'))
  }

  return {
    sent: sent.count ?? 0,
    delivered: delivered.count ?? 0,
    pending: pending.count ?? 0,
    failed: failed.count ?? 0,
  }
}

export async function sendManualSms(input: {
  recipient: string
  message: string
}): Promise<AppointmentSmsResult> {
  const { data, error } = await supabase.functions.invoke('send-sms', {
    body: { recipient: input.recipient, message: input.message },
  })
  if (error) {
    let message = ''
    const context = (error as { context?: unknown }).context
    if (context instanceof Response) {
      try {
        const parsed = await context.json()
        if (parsed && typeof parsed.error === 'string') message = parsed.error
      } catch {
        // Keep the safe generic fallback below.
      }
    }
    throw new Error(message || errorMessage(error, 'SMS notification could not be sent.'))
  }
  return data as AppointmentSmsResult
}

export async function getSmsInbox(): Promise<SmsInboxMessage[]> {
  const { data, error } = await supabase
    .from('sms_inbox')
    .select('id, provider_message_id, sender, message, received_at, is_read, created_at')
    .order('received_at', { ascending: false })
    .limit(100)

  if (error) throw new Error(errorMessage(error, 'Failed to load SMS inbox.'))
  return (data ?? []) as SmsInboxMessage[]
}

export async function getUnreadSmsCount(): Promise<number> {
  const { count, error } = await supabase
    .from('sms_inbox')
    .select('id', { count: 'exact', head: true })
    .eq('is_read', false)

  if (error) throw new Error(errorMessage(error, 'Failed to load unread SMS count.'))
  return count ?? 0
}

export async function markSmsMessageRead(id: string, isRead: boolean): Promise<void> {
  const { error } = await supabase.from('sms_inbox').update({ is_read: isRead }).eq('id', id)
  if (error) throw new Error(errorMessage(error, 'Failed to update SMS read status.'))
}

export async function getSmsConversation(phone: string): Promise<SmsConversationMessage[]> {
  const canonical = toCanonicalPhilippineMobile(phone)
  if (!canonical) throw new Error('A valid Philippine mobile number is required.')

  const [inbound, outbound] = await Promise.all([
    supabase
      .from('sms_inbox')
      .select('id, sender, message, received_at')
      .order('received_at', { ascending: false })
      .limit(200),
    supabase
      .from('notification_logs')
      .select('id, recipient, message, status, created_at, sent_at')
      .eq('type', 'sms')
      .order('created_at', { ascending: false })
      .limit(200),
  ])

  if (inbound.error) throw new Error(errorMessage(inbound.error, 'Failed to load inbound SMS messages.'))
  if (outbound.error) throw new Error(errorMessage(outbound.error, 'Failed to load outbound SMS messages.'))

  const inboundMessages = ((inbound.data ?? []) as {
    id: string
    sender: string
    message: string
    received_at: string
  }[])
    .filter((row) => toCanonicalPhilippineMobile(row.sender) === canonical)
    .map((row): SmsConversationMessage => ({
      id: row.id,
      direction: 'inbound',
      phone: canonical,
      message: row.message,
      created_at: row.received_at,
    }))

  const outboundMessages = ((outbound.data ?? []) as {
    id: string
    recipient: string
    message: string
    status: NotificationStatus
    created_at: string
    sent_at: string | null
  }[])
    .filter((row) => toCanonicalPhilippineMobile(row.recipient) === canonical)
    .map((row): SmsConversationMessage => ({
      id: row.id,
      direction: 'outbound',
      phone: canonical,
      message: row.message,
      created_at: row.sent_at ?? row.created_at,
      status: row.status,
    }))

  return [...inboundMessages, ...outboundMessages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )
}

async function trySendAppointmentSms(
  event: AppointmentSmsEvent,
  appointmentId: string
): Promise<AppointmentSmsResult> {
  try {
    return await sendAppointmentSms(event, appointmentId)
  } catch (err) {
    console.warn('Appointment SMS notification failed:', err)
    return { success: false }
  }
}

export interface QueueTicket {
  id: string
  ticket_number: string
  queue_position: number
  status: 'waiting' | 'now_serving'
  appointments: {
    id: string
    provider_id: string
    status: string
    services: { name: string }
    patients: { profiles: { full_name: string } }
    providers: { profiles: { full_name: string } }
    time_slots: { slot_datetime: string }
  }
}

export interface ScannedQueueTicket {
  id: string
  ticket_number: string
  queue_position: number
  status: 'waiting' | 'now_serving' | 'done'
  appointments: {
    id: string
    status: string
    appointment_at: string
    services: { name: string }
    patients: { profiles: { full_name: string } }
    providers: { profiles: { full_name: string } }
  }
}

export interface UpcomingAppointment {
  id: string
  status: string
  appointment_at: string
  services: { name: string }
  patients: { profiles: { full_name: string } }
  providers: { profiles: { full_name: string } }
  queue_tickets: {
    ticket_number: string
    queue_position: number
    status: string
  } | null
}

// Today's Asia/Manila day boundaries, returned as UTC ISO strings for
// timestamptz comparisons.
function manilaDayWindow(): { today: string; start: string; end: string; tomorrowStart: string } {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
  const tomorrow = new Date(`${today}T00:00:00+08:00`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  return {
    today,
    start: new Date(`${today}T00:00:00+08:00`).toISOString(),
    end: new Date(`${today}T23:59:59+08:00`).toISOString(),
    tomorrowStart: tomorrow.toISOString(),
  }
}

export function manilaDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
}

export function todayManilaDateKey(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
}

export async function fetchTodayQueue(): Promise<QueueTicket[]> {
  const { start, end } = manilaDayWindow()
  const { data, error } = await supabase
    .from('queue_tickets')
    .select(
      `
      id, ticket_number, queue_position, status,
      appointments!inner (
        id, provider_id, status,
        services ( name ),
        patients ( profiles ( full_name ) ),
        providers ( profiles ( full_name ) ),
        time_slots!inner ( slot_datetime )
      )
    `
    )
    .in('status', ['waiting', 'now_serving'])
    .in('appointments.status', ['booked', 'checked_in'])
    .gte('appointments.time_slots.slot_datetime', start)
    .lte('appointments.time_slots.slot_datetime', end)
    .order('queue_position')

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return data as unknown as QueueTicket[]
}

export async function fetchQueueTicketByQrToken(token: string): Promise<ScannedQueueTicket | null> {
  const { data, error } = await supabase
    .from('queue_tickets')
    .select(
      `
      id, ticket_number, queue_position, status,
      appointments!inner (
        id, status, appointment_at,
        services ( name ),
        patients ( profiles ( full_name ) ),
        providers ( profiles ( full_name ) )
      )
    `
    )
    .eq('qr_code', token)
    .maybeSingle()

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  if (!data) return null

  const first = <T>(value: T | T[] | null | undefined): T | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null)

  const row = data as unknown as Omit<ScannedQueueTicket, 'appointments'> & {
    appointments:
      | (Omit<ScannedQueueTicket['appointments'], 'services' | 'patients' | 'providers'> & {
          services: ScannedQueueTicket['appointments']['services'] | ScannedQueueTicket['appointments']['services'][]
          patients: ScannedQueueTicket['appointments']['patients'] | ScannedQueueTicket['appointments']['patients'][]
          providers: ScannedQueueTicket['appointments']['providers'] | ScannedQueueTicket['appointments']['providers'][]
        })
      | Array<
          Omit<ScannedQueueTicket['appointments'], 'services' | 'patients' | 'providers'> & {
            services: ScannedQueueTicket['appointments']['services'] | ScannedQueueTicket['appointments']['services'][]
            patients: ScannedQueueTicket['appointments']['patients'] | ScannedQueueTicket['appointments']['patients'][]
            providers: ScannedQueueTicket['appointments']['providers'] | ScannedQueueTicket['appointments']['providers'][]
          }
        >
  }
  const appointment = first(row.appointments)
  if (!appointment) return null

  return {
    id: row.id,
    ticket_number: row.ticket_number,
    queue_position: row.queue_position,
    status: row.status,
    appointments: {
      id: appointment.id,
      status: appointment.status,
      appointment_at: appointment.appointment_at,
      services: first(appointment.services) ?? { name: '' },
      patients: first(appointment.patients) ?? { profiles: { full_name: '' } },
      providers: first(appointment.providers) ?? { profiles: { full_name: '' } },
    },
  }
}

export async function fetchUpcomingAppointments(): Promise<UpcomingAppointment[]> {
  const { tomorrowStart } = manilaDayWindow()
  const { data, error } = await supabase
    .from('appointments')
    .select(
      `
      id, status, appointment_at,
      services ( name ),
      patients ( profiles ( full_name ) ),
      providers ( profiles ( full_name ) ),
      queue_tickets ( ticket_number, queue_position, status )
    `
    )
    .eq('status', 'booked')
    .gte('appointment_at', tomorrowStart)
    .order('appointment_at', { ascending: true })
    .limit(100)

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))

  const first = <T>(value: T | T[] | null | undefined): T | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null)

  return (data ?? []).map((row) => {
    const typed = row as unknown as {
      id: string
      status: string
      appointment_at: string
      services: UpcomingAppointment['services'] | UpcomingAppointment['services'][]
      patients: UpcomingAppointment['patients'] | UpcomingAppointment['patients'][]
      providers: UpcomingAppointment['providers'] | UpcomingAppointment['providers'][]
      queue_tickets: UpcomingAppointment['queue_tickets'] | UpcomingAppointment['queue_tickets'][]
    }
    return {
      id: typed.id,
      status: typed.status,
      appointment_at: typed.appointment_at,
      services: first(typed.services) ?? { name: '' },
      patients: first(typed.patients) ?? { profiles: { full_name: '' } },
      providers: first(typed.providers) ?? { profiles: { full_name: '' } },
      queue_tickets: first(typed.queue_tickets),
    }
  })
}

export interface AdvanceResult {
  // Absent when the queue was empty (only someone was finished, nobody called).
  ticket_id?: string
  ticket_number?: string
  queue_position?: number
  appointment_id?: string
  // The now_serving appointment that was just marked served, if any.
  served_appointment_id?: string | null
  smsNotificationFailed?: boolean
}

// "Call next": finishes the current patient (served) and promotes the next
// ticket. Then texts BOTH — a thank-you to the one served and "it's your turn"
// to the one now being called. Either SMS failing never fails the advance.
export async function advanceQueue(providerId: string): Promise<AdvanceResult | null> {
  const { data, error } = await supabase.rpc('advance_queue', { p_provider_id: providerId })
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  const result = data as AdvanceResult | null
  if (!result) return null

  const sends: Promise<AppointmentSmsResult>[] = []
  if (result.served_appointment_id) {
    sends.push(trySendAppointmentSms('appointment_served', result.served_appointment_id))
  }
  if (result.appointment_id) {
    sends.push(trySendAppointmentSms('queue_now_serving', result.appointment_id))
  }
  const outcomes = await Promise.all(sends)
  return { ...result, smsNotificationFailed: outcomes.some((o) => !o.success) }
}

export interface AdminStats {
  totalPatients: number
  totalProviders: number
  appointmentsToday: number
  ticketsWaitingToday: number
}

// Overview stat cards. Uses head+count queries (no rows fetched — just the
// count header). RLS already lets admin read every row in these tables.
export async function fetchAdminStats(): Promise<AdminStats> {
  const { start, end } = manilaDayWindow()

  const [patients, providers, appts, waiting] = await Promise.all([
    supabase.from('patients').select('*', { count: 'exact', head: true }),
    supabase.from('providers').select('*', { count: 'exact', head: true }),
    supabase
      .from('appointments')
      .select('id, time_slots!inner ( slot_datetime )', { count: 'exact', head: true })
      .neq('status', 'cancelled')
      .gte('time_slots.slot_datetime', start)
      .lte('time_slots.slot_datetime', end),
    supabase
      .from('queue_tickets')
      .select('id, appointments!inner ( time_slots!inner ( slot_datetime ) )', {
        count: 'exact',
        head: true,
      })
      .eq('status', 'waiting')
      .in('appointments.status', ['booked', 'checked_in'])
      .gte('appointments.time_slots.slot_datetime', start)
      .lte('appointments.time_slots.slot_datetime', end),
  ])

  for (const result of [patients, providers, appts, waiting]) {
    if (result.error) throw new Error(errorMessage(result.error, GENERIC_ERR))
  }

  return {
    totalPatients: patients.count ?? 0,
    totalProviders: providers.count ?? 0,
    appointmentsToday: appts.count ?? 0,
    ticketsWaitingToday: waiting.count ?? 0,
  }
}

// ------------------------------------------------------------
// Admin: patient-volume descriptive analytics (Overview chart)
// ------------------------------------------------------------

// ONE aggregate query per granularity. `rpc` is one of the migration-0012
// function names (see GRANULARITY_CONFIG in volume.ts). Returns only the
// periods that have rows; the caller zero-fills the gaps. RLS scopes an
// admin to every appointment, so totals are true totals.
export async function fetchAppointmentVolume(
  rpc: string,
  from: string,
  to: string
): Promise<VolumeBucket[]> {
  const { data, error } = await supabase.rpc(rpc, { p_from: from, p_to: to })
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return (data ?? []) as VolumeBucket[]
}

// Count of past-dated appointments still marked 'booked' — never closed
// out by staff. head+count only (no rows fetched); we surface the number
// but NEVER auto-reclassify (that is a data decision, not a display one).
export async function fetchStaleBookedCount(todayManila: string): Promise<number> {
  const { count, error } = await supabase
    .from('appointments')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'booked')
    .lt('appointment_date', todayManila)
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return count ?? 0
}

// ------------------------------------------------------------
// Admin: user & role management
// ------------------------------------------------------------
export type ProviderType = 'doctor' | 'nurse' | 'dentist'

export interface AdminUser {
  id: string
  full_name: string
  role: Role
  email: string | null
  created_at: string
}

// Admin reads every profile via the "staff/admin: select all profiles" policy.
export async function fetchAllProfiles(): Promise<AdminUser[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role, email, created_at')
    .order('created_at', { ascending: false })

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return data as AdminUser[]
}

// Invokes an admin Edge Function. functions.invoke automatically attaches the
// current session's JWT as the Authorization header — that token is how the
// function verifies the caller is an admin. On an HTTP error we dig the safe
// message out of the function's JSON body (never internal details).
async function callAdminFunction<T>(name: string, body: object): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, {
    body: body as Record<string, unknown>,
  })
  if (error) {
    let message = ''
    const context = (error as { context?: unknown }).context
    if (context instanceof Response) {
      try {
        const parsed = await context.json()
        if (parsed && typeof parsed.error === 'string') message = parsed.error
      } catch {
        // body wasn't JSON — fall through to the generic message
      }
    }
    throw new Error(message || errorMessage(error, GENERIC_ERR))
  }
  return data as T
}

async function callPublicFunction<T>(name: string, body: object): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, {
    body: body as Record<string, unknown>,
  })
  if (error) {
    const context = (error as { context?: unknown }).context
    // The function's own JSON `error` is already user-safe text (e.g.
    // "Incorrect code…") — surface it instead of the generic fallback.
    let message = ''
    let responseBody = ''
    if (context instanceof Response) {
      try {
        responseBody = await context.clone().text()
        const parsed = JSON.parse(responseBody)
        if (parsed && typeof parsed.error === 'string') message = parsed.error
      } catch {
        // body wasn't JSON — fall through to the generic message
      }
    }
    if (import.meta.env.DEV) {
      console.error(`${name} failed`, {
        message: error.message,
        status: context instanceof Response ? context.status : undefined,
        responseBody,
      })
    }
    throw new Error(message || errorMessage(error, GENERIC_ERR))
  }
  return data as T
}

export interface CreateUserInput {
  email: string
  fullName: string
  role: Role
  phone?: string
  providerType?: ProviderType
  specialization?: string
  password?: string
}

export interface CreateUserResult {
  userId: string
  email: string
  role: Role
  generatedPassword?: string
}

export async function adminCreateUser(input: CreateUserInput): Promise<CreateUserResult> {
  return callAdminFunction<CreateUserResult>('admin-create-user', input)
}

export interface UpdateRoleInput {
  userId: string
  role: Role
  providerType?: ProviderType
  specialization?: string
}

export async function adminUpdateRole(
  input: UpdateRoleInput
): Promise<{ userId: string; role: Role }> {
  return callAdminFunction('admin-update-role', input)
}

// ------------------------------------------------------------
// Password reset requests
// ------------------------------------------------------------
export interface PasswordResetRequest {
  id: string
  status: 'pending' | 'approved' | 'completed' | 'rejected' | 'expired' | 'failed'
  requested_at: string
  approved_at: string | null
  completed_at: string | null
  token_expires_at: string | null
  processed_at: string | null
  profiles: {
    full_name: string
    email: string | null
    role: Role
  }
}

export interface PasswordResetStart {
  verified: boolean
  // Opaque id the browser hands back with the SMS code. Not a secret by
  // itself — the code (texted, never returned here) is the second factor.
  requestId?: string
  expiresAt?: string
  phoneHint?: string // e.g. "+63••••••4567"
  smsSent?: boolean
  resent?: boolean // false when a still-valid code was sent < 60 s ago
}

// Step 1 of the SMS password reset: verify name + email + phone, then the
// Edge Function texts a 6-digit code to the registered number.
export async function submitPasswordResetRequest(input: {
  email: string
  fullName: string
  phone: string
}): Promise<PasswordResetStart> {
  const body = {
    email: input.email.trim().toLowerCase(),
    fullName: input.fullName.trim(),
    phone: input.phone.trim(),
  }
  const result = await callPublicFunction<PasswordResetStart>('password-reset-request', body)
  if (import.meta.env.DEV) {
    console.info('password-reset-request browser response', JSON.stringify({
      verified: result.verified,
      hasRequestId: typeof result.requestId === 'string' && result.requestId.length > 0,
      smsSent: result.smsSent,
    }))
  }
  return result
}

// Step 2: the code from the SMS + the new password.
export async function completePasswordReset(input: {
  requestId: string
  code: string
  newPassword: string
}): Promise<{ completed: true }> {
  return callPublicFunction('password-reset-complete', input)
}

export async function fetchPasswordResetRequests(): Promise<PasswordResetRequest[]> {
  const { data, error } = await supabase
    .from('password_reset_requests')
    .select(
      `
      id, status, requested_at, approved_at, completed_at, token_expires_at, processed_at,
      profiles:profiles!password_reset_requests_profile_id_fkey!inner ( full_name, email, role )
    `
    )
    .order('requested_at', { ascending: false })
    .limit(100)

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return data as unknown as PasswordResetRequest[]
}

// ------------------------------------------------------------
// Admin: provider availability & time-slot generation
// ------------------------------------------------------------
export interface ProviderAvailability {
  id: string
  day_of_week: number // 0 = Sunday … 6 = Saturday
  start_time: string // 'HH:MM:SS'
  end_time: string
}

export interface ProviderWithAvailability {
  id: string
  provider_type: ProviderType
  specialization: string | null
  profiles: { full_name: string }
  provider_availability: ProviderAvailability[]
}

export async function fetchProvidersWithAvailability(): Promise<ProviderWithAvailability[]> {
  const { data, error } = await supabase
    .from('providers')
    .select(
      `
      id, provider_type, specialization,
      profiles!inner ( full_name ),
      provider_availability ( id, day_of_week, start_time, end_time )
    `
    )
    .order('provider_type')

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return data as unknown as ProviderWithAvailability[]
}

// Admin insert/delete allowed by the "admin: manage availability" policy.
export async function addAvailability(input: {
  providerId: string
  dayOfWeek: number
  startTime: string
  endTime: string
}): Promise<void> {
  const { error } = await supabase.from('provider_availability').insert({
    provider_id: input.providerId,
    day_of_week: input.dayOfWeek,
    start_time: input.startTime,
    end_time: input.endTime,
  })
  if (error) {
    if (error.code === '23505') {
      throw new Error(
        'This day and start time already has a schedule window.'
      )
    }
    if (error.code === '23514') {
      throw new Error('The end time must be after the start time.')
    }
    throw new Error(errorMessage(error, GENERIC_ERR))
  }
}

export async function deleteAvailability(id: string): Promise<void> {
  const { error } = await supabase.from('provider_availability').delete().eq('id', id)
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
}

export interface TimeOff {
  id: string
  provider_id: string | null // null = clinic-wide holiday
  exception_date: string // 'YYYY-MM-DD'
  reason: string | null
  providers: { profiles: { full_name: string } } | null
}

export async function fetchTimeOff(): Promise<TimeOff[]> {
  const { data, error } = await supabase
    .from('provider_time_off')
    .select(
      `
      id, provider_id, exception_date, reason,
      providers ( profiles ( full_name ) )
    `
    )
    .order('exception_date')

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return data as unknown as TimeOff[]
}

// providerId null = clinic-wide holiday for every provider.
export async function addTimeOff(input: {
  providerId: string | null
  exceptionDate: string
  reason?: string
}): Promise<void> {
  const { error } = await supabase.from('provider_time_off').insert({
    provider_id: input.providerId,
    exception_date: input.exceptionDate,
    reason: input.reason?.trim() || null,
  })
  if (error) {
    if (error.code === '23505') {
      throw new Error(
        'An exception date is already set for that provider and date.'
      )
    }
    throw new Error(errorMessage(error, GENERIC_ERR))
  }
}

export async function deleteTimeOff(id: string): Promise<void> {
  const { error } = await supabase.from('provider_time_off').delete().eq('id', id)
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
}

export interface ExceptionConflict {
  appointment_id: string
  patient_name: string
  service_name: string
  provider_name: string
  slot_datetime: string
  status: string
  service_id: string // for the admin reschedule slot lookup (0021)
  queue_status: 'waiting' | 'now_serving' | 'done' | null
  emergency_reschedule_blocked?: boolean
}

// Active appointments that an exception on p_date would strand. The SAME
// query backs the pre-warn count and the post-commit list, so what the admin
// is warned about equals what they then act on. providerId null = clinic-wide.
export async function fetchExceptionConflicts(
  providerId: string | null,
  date: string
): Promise<ExceptionConflict[]> {
  const { data, error } = await supabase.rpc('list_exception_appointments', {
    p_provider_id: providerId,
    p_date: date,
  })
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return (data ?? []) as ExceptionConflict[]
}

export interface AdminRescheduleProposal {
  id: string
  appointment_id: string
  status: string
  original_appointment_at: string
  proposed_appointment_at: string
  reason: string
  token_expires_at: string
  responded_at: string | null
  patients: { profiles: { full_name: string } }
  services: { name: string }
  providers: { profiles: { full_name: string } }
  appointments: { status: string; queue_tickets: { ticket_number: string } | null } | null
}

export async function fetchAdminRescheduleProposals(input: {
  providerId?: string
  date?: string
} = {}): Promise<AdminRescheduleProposal[]> {
  let query = supabase
    .from('appointment_reschedule_proposals')
    .select(
      `
      id, appointment_id, status, original_appointment_at, proposed_appointment_at,
      reason, token_expires_at, responded_at,
      patients ( profiles ( full_name ) ),
      services ( name ),
      providers ( profiles ( full_name ) ),
      appointments ( status, queue_tickets ( ticket_number ) )
    `
    )
    .order('created_at', { ascending: false })
    .limit(100)

  if (input.providerId) query = query.eq('provider_id', input.providerId)
  if (input.date) {
    const { start, end } = manilaDayWindowFor(input.date)
    query = query.gte('original_appointment_at', start).lte('original_appointment_at', end)
  }

  const { data, error } = await query
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return (data ?? []) as unknown as AdminRescheduleProposal[]
}

// ------------------------------------------------------------
// Announcements
// ------------------------------------------------------------
export interface Announcement {
  id: string
  title: string
  body: string
  published: boolean
  created_at: string
  // Set by send-announcement-sms after a broadcast (migration 0021).
  sms_sent_at: string | null
  sms_recipient_count: number | null
}

export interface AnnouncementSmsResult {
  success: boolean
  total: number // patients still owed this announcement at the start of the run
  sent: number
  failed: number
  skipped: number // not attempted (time budget / cap / fatal gateway error)
  message: string // the exact SMS text that went out
}

// Patients who would receive an announcement broadcast: role patient with a
// canonical +639… number. Admin reads every profile via the staff/admin policy.
export async function countAnnouncementSmsRecipients(): Promise<number> {
  const { count, error } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'patient')
    .like('phone', '+639%')
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return count ?? 0
}

// Explicit admin action — never a side effect of publishing. The Edge
// Function fans out one SMS per patient and skips anyone already sent this
// announcement, so re-running only reaches the ones still missing.
export function sendAnnouncementSms(announcementId: string): Promise<AnnouncementSmsResult> {
  return callAdminFunction<AnnouncementSmsResult>('send-announcement-sms', {
    announcement_id: announcementId,
  })
}

// Admin list — the "admin: manage announcements" policy is FOR ALL, so admins
// can read drafts as well as published rows.
export async function fetchAllAnnouncements(): Promise<Announcement[]> {
  const { data, error } = await supabase
    .from('announcements')
    .select('id, title, body, published, created_at, sms_sent_at, sms_recipient_count')
    .order('created_at', { ascending: false })

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return data as Announcement[]
}

// Public feed — RLS already limits anon/authenticated to published rows; the
// explicit filter also keeps an admin's feed view to published only.
export async function fetchPublishedAnnouncements(): Promise<Announcement[]> {
  const { data, error } = await supabase
    .from('announcements')
    .select('id, title, body, published, created_at, sms_sent_at, sms_recipient_count')
    .eq('published', true)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return data as Announcement[]
}

export async function createAnnouncement(input: {
  title: string
  body: string
  published: boolean
  postedBy?: string
}): Promise<void> {
  const { error } = await supabase.from('announcements').insert({
    title: input.title.trim(),
    body: input.body.trim(),
    published: input.published,
    posted_by: input.postedBy ?? null,
  })
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
}

export async function updateAnnouncement(
  id: string,
  input: { title: string; body: string }
): Promise<void> {
  const { error } = await supabase
    .from('announcements')
    .update({ title: input.title.trim(), body: input.body.trim() })
    .eq('id', id)
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
}

export async function setAnnouncementPublished(id: string, published: boolean): Promise<void> {
  const { error } = await supabase.from('announcements').update({ published }).eq('id', id)
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
}

export async function deleteAnnouncement(id: string): Promise<void> {
  const { error } = await supabase.from('announcements').delete().eq('id', id)
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
}

export interface SlotGenInput {
  providerId: string
  serviceId: string
  from: string // 'YYYY-MM-DD'
  to: string
  intervalMinutes: number
}

export interface SlotGenSummary {
  dry_run: boolean
  to_create: number
  already_exist: number
  stale_unbooked_removed?: number
  exception_days: number
  days_with_availability: number
  interval_minutes: number
  sample: string[] // ISO timestamps of the first would-be slots
}

// The RPC re-checks is_admin() internally (SECURITY DEFINER bypasses RLS).
// dry_run = true previews without writing; both paths share the same code.
async function callGenerateSlots(input: SlotGenInput, dryRun: boolean): Promise<SlotGenSummary> {
  const { data, error } = await supabase.rpc('generate_time_slots', {
    p_provider_id: input.providerId,
    p_service_id: input.serviceId,
    p_from: input.from,
    p_to: input.to,
    p_interval_minutes: input.intervalMinutes,
    p_dry_run: dryRun,
  })
  if (error) throw new Error(slotGenErrorMessage(error))
  return data as SlotGenSummary
}

// Translate generate_time_slots RPC raises into admin-friendly text.
function slotGenErrorMessage(error: unknown): string {
  const raw = (error as { message?: string }).message ?? ''
  if (raw.includes('ERR_INVALID_INTERVAL'))
    return 'Interval must be between 5 and 480 minutes.'
  if (raw.includes('ERR_INVALID_RANGE'))
    return 'The from date must be on or before the to date.'
  if (raw.includes('ERR_RANGE_TOO_LARGE'))
    return 'The date range cannot exceed 180 days.'
  if (raw.includes('ERR_NOT_FOUND'))
    return 'The selected provider or service was not found.'
  if (raw.includes('ERR_FORBIDDEN'))
    return 'Only an administrator can generate slots.'
  return errorMessage(error, GENERIC_ERR)
}

export async function previewSlots(input: SlotGenInput): Promise<SlotGenSummary> {
  return callGenerateSlots(input, true)
}

export async function generateSlots(input: SlotGenInput): Promise<SlotGenSummary> {
  return callGenerateSlots(input, false)
}

export async function fetchMyAppointments(): Promise<Appointment[]> {
  const { data, error } = await supabase
    .from('appointments')
    .select(
      `
      id, status, service_id,
      services ( name ),
      providers ( profiles ( full_name ) ),
      time_slots ( slot_datetime ),
      queue_tickets ( ticket_number, queue_position, qr_code, status ),
      appointment_reschedule_proposals (
        id, status, proposed_appointment_at, reason, token_expires_at
      )
    `
    )
    .in('status', ['booked', 'checked_in'])
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return normalizeAppointments(data ?? [])
}

// ------------------------------------------------------------
// Admin/staff Reports page (migration 0017 aggregate RPCs)
// ------------------------------------------------------------
export interface AppointmentSummary {
  booked: number
  checked_in: number
  served: number
  no_show: number
  cancelled: number
  total: number
}

const EMPTY_SUMMARY: AppointmentSummary = {
  booked: 0,
  checked_in: 0,
  served: 0,
  no_show: 0,
  cancelled: 0,
  total: 0,
}

// Per-status counts + total for the range. 0012's volume RPCs collapse
// checked_in+served into "attended", so they can't produce this split — hence
// a dedicated RPC. The Rates report derives from THIS same object (no second
// query path), and both feed the export.
export async function fetchAppointmentSummary(
  from: string,
  to: string
): Promise<AppointmentSummary> {
  const { data, error } = await supabase.rpc('report_appointment_summary', {
    p_from: from,
    p_to: to,
  })
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return ((data as AppointmentSummary[] | null)?.[0]) ?? EMPTY_SUMMARY
}

export interface ReportCount {
  name: string
  count: number
}

export async function fetchReportByService(from: string, to: string): Promise<ReportCount[]> {
  const { data, error } = await supabase.rpc('report_by_service', { p_from: from, p_to: to })
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return ((data ?? []) as { service_name: string; count: number }[]).map((r) => ({
    name: r.service_name,
    count: r.count,
  }))
}

export async function fetchReportByProvider(from: string, to: string): Promise<ReportCount[]> {
  const { data, error } = await supabase.rpc('report_by_provider', { p_from: from, p_to: to })
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return ((data ?? []) as { provider_name: string; count: number }[]).map((r) => ({
    name: r.provider_name,
    count: r.count,
  }))
}

export interface PatientStats {
  total: number
  newInRange: number
  active: number
}

export async function fetchPatientStats(from: string, to: string): Promise<PatientStats> {
  const { data, error } = await supabase.rpc('report_patient_stats', { p_from: from, p_to: to })
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  const row = (data as { total_patients: number; new_patients: number; active_patients: number }[] | null)?.[0]
  return {
    total: row?.total_patients ?? 0,
    newInRange: row?.new_patients ?? 0,
    active: row?.active_patients ?? 0,
  }
}

// ------------------------------------------------------------
// Doctor appointment schedule (own assigned appointments only)
// ------------------------------------------------------------
export interface DoctorAppointment {
  id: string
  status: string
  time_slots: { slot_datetime: string }
  services: { name: string }
  patients: { profiles: { full_name: string; phone: string | null } | null } | null
  queue_tickets: { ticket_number: string } | null
}

// Appointments assigned to the logged-in doctor within one Manila-month window.
// RLS ("provider: select own appointments") already scopes this to provider_id =
// my_provider_id() — a PROVIDER-based filter, not service-based — so a second
// dentist would never see the first dentist's patients. Patient name/phone come
// via the provider-scoped profiles/patients policies; ticket_number via the new
// provider policy in migration 0016. Every status is included; caller sorts.
export async function fetchDoctorAppointments(
  monthStartISO: string,
  monthEndISO: string
): Promise<DoctorAppointment[]> {
  const { data, error } = await supabase
    .from('appointments')
    .select(
      `
      id, status, service_id,
      time_slots!inner ( slot_datetime ),
      services ( name ),
      patients ( profiles ( full_name, phone ) ),
      queue_tickets ( ticket_number )
    `
    )
    .gte('time_slots.slot_datetime', monthStartISO)
    .lte('time_slots.slot_datetime', monthEndISO)

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))

  // queue_tickets is a to-one embed (unique appointment_id) → object or null,
  // but normalize defensively in case relationship detection hands back an array.
  return (data as unknown as DoctorAppointment[]).map((row) => ({
    ...row,
    queue_tickets: Array.isArray(row.queue_tickets)
      ? (row.queue_tickets[0] ?? null)
      : (row.queue_tickets ?? null),
  }))
}

// ------------------------------------------------------------
// Public QR check-in status page (/checkin/:code)
// ------------------------------------------------------------
export interface CheckinStatus {
  ticket_number: string
  queue_position: number
  status: string
  service_name: string
  provider_name: string
  slot_datetime: string
}

// Anonymous, read-only lookup via the checkin_status SECURITY DEFINER RPC
// (migration 0015). Returns null for an unknown/invalid code so the page can
// show a plain "not found" without leaking anything. The RPC intentionally
// returns none of the patient's identifying data.
export async function fetchCheckinStatus(code: string): Promise<CheckinStatus | null> {
  const { data, error } = await supabase.rpc('checkin_status', { p_code: code })
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  const rows = (data ?? []) as CheckinStatus[]
  return rows[0] ?? null
}

// ------------------------------------------------------------
// Patient profile page
// ------------------------------------------------------------
export interface PatientProfile {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  additional_emails: string[]
  additional_phones: string[]
}

// Read-only basic profile info. RLS ("own profile: select") already limits a
// patient to their own row; the explicit id filter keeps the read to one row.
export async function fetchMyProfile(userId: string): Promise<PatientProfile> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, email, phone, alternate_phone, alternate_email')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    const raw = error.message ?? ''
    if (/alternate_(phone|email)|schema cache/i.test(raw)) {
      const fallback = await supabase
        .from('profiles')
        .select('id, full_name, email, phone')
        .eq('id', userId)
        .maybeSingle()
      if (fallback.error) throw new Error(errorMessage(fallback.error, GENERIC_ERR))
      if (!fallback.data) {
        throw new Error('Hindi mahanap ang iyong profile. / Your profile could not be found.')
      }
      return {
        ...(fallback.data as Omit<PatientProfile, 'additional_emails' | 'additional_phones'>),
        additional_emails: [],
        additional_phones: [],
      }
    }
    throw new Error(errorMessage(error, GENERIC_ERR))
  }
  if (!data) throw new Error('Hindi mahanap ang iyong profile. / Your profile could not be found.')

  const base = data as {
    id: string
    full_name: string
    email: string | null
    phone: string | null
    alternate_phone?: string | null
    alternate_email?: string | null
  }

  const contacts = await supabase
    .from('profile_contacts')
    .select('contact_type, contact_value, created_at')
    .eq('profile_id', userId)
    .order('created_at', { ascending: true })

  let additionalEmails: string[] = []
  let additionalPhones: string[] = []

  if (contacts.error) {
    const raw = contacts.error.message ?? ''
    if (!/profile_contacts|schema cache/i.test(raw)) {
      throw new Error(errorMessage(contacts.error, GENERIC_ERR))
    }
    if (base.alternate_email) additionalEmails = [base.alternate_email]
    if (base.alternate_phone) additionalPhones = [base.alternate_phone]
  } else {
    const rows = (contacts.data ?? []) as {
      contact_type: 'email' | 'phone'
      contact_value: string
    }[]
    additionalEmails = rows
      .filter((row) => row.contact_type === 'email')
      .map((row) => row.contact_value)
    additionalPhones = rows
      .filter((row) => row.contact_type === 'phone')
      .map((row) => row.contact_value)
  }

  return {
    id: base.id,
    full_name: base.full_name,
    email: base.email,
    phone: base.phone,
    additional_emails: additionalEmails,
    additional_phones: additionalPhones,
  }
}

export interface UpdateMyProfileInput {
  email: string
  phone: string
  additionalEmails: string[]
  additionalPhones: string[]
}

export interface UpdateMyProfileResult {
  profile: PatientProfile
  emailConfirmationRequired: boolean
  emailAlreadyDefault?: boolean
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVISIBLE_EMAIL_WHITESPACE_RE = /[\u200B-\u200D\uFEFF]/g

function uniqueNormalizedEmails(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)))
}

function normalizeEmailForAuth(value: string): string {
  return value.replace(INVISIBLE_EMAIL_WHITESPACE_RE, '').trim().toLowerCase()
}

function uniqueCanonicalPhones(values: string[]): string[] {
  const phones: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const canonical = toCanonicalPhilippineMobile(trimmed)
    if (!canonical) {
      throw new Error('Enter a valid additional Philippine cellphone number. Example: 9171234567.')
    }
    if (!phones.includes(canonical)) phones.push(canonical)
  }
  return phones
}

function profilePromotionError(error: unknown, fallback: string): Error {
  const obj = error && typeof error === 'object' ? (error as Record<string, unknown>) : null
  const code = typeof obj?.code === 'string' ? obj.code : ''
  const status = typeof obj?.status === 'number' ? obj.status : 0
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (code === 'email_address_invalid') {
    return new Error('The selected email address is not valid. Please remove it and add the email again.')
  }
  if (
    status === 429 ||
    /rate.?limit|too many|only request this after|over_.*rate_limit/i.test(`${code} ${message}`)
  ) {
    return new Error('Too many email-change attempts. Please try again later.')
  }
  if (
    status === 401 ||
    status === 403 ||
    /reauth|session|jwt|not.?authenticated|login required|token/i.test(`${code} ${message}`)
  ) {
    return new Error('Your session has expired. Please sign in again, then try updating your default email.')
  }
  if (
    code === 'email_exists' ||
    /already.*registered|already.*exists|duplicate|unique|User already registered/i.test(message)
  ) {
    return new Error('This email is already associated with another account.')
  }
  if (/ERR_CONTACT_NOT_FOUND/i.test(message)) {
    return new Error('That additional contact is no longer available. Please refresh and try again.')
  }
  if (/ERR_SAME_EMAIL/i.test(message)) {
    return new Error('This is already your default email.')
  }
  if (/ERR_SAME_PHONE/i.test(message)) {
    return new Error('This is already your default cellphone number.')
  }
  if (/ERR_INVALID_EMAIL|valid email/i.test(message)) {
    return new Error('Please enter a valid email address.')
  }
  if (/ERR_INVALID_PHONE|Philippine|cellphone|phone/i.test(message)) {
    return new Error('Please enter a valid Philippine cellphone number.')
  }
  return new Error(fallback)
}

function logDefaultEmailPromotionFailure(stage: string, error: unknown) {
  const obj = error && typeof error === 'object' ? (error as Record<string, unknown>) : null
  console.error('[default-email-promotion]', {
    stage,
    code: typeof obj?.code === 'string' ? obj.code : undefined,
    status: typeof obj?.status === 'number' ? obj.status : undefined,
    message: error instanceof Error ? error.message : String(error ?? ''),
  })
}

function logDefaultEmailPromotionState(stage: string, details: Record<string, string | boolean>) {
  console.info('[default-email-promotion]', { stage, ...details })
}

async function callAuthenticatedFunction<T>(name: string, body: object): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, {
    body: body as Record<string, unknown>,
  })
  if (error) {
    let message = ''
    const context = (error as { context?: unknown }).context
    if (context instanceof Response) {
      try {
        const parsed = await context.json()
        if (parsed && typeof parsed.error === 'string') message = parsed.error
      } catch {
        // Keep the safe generic fallback below.
      }
    }
    throw new Error(message || errorMessage(error, GENERIC_ERR))
  }
  return data as T
}

export async function promoteDefaultPhoneContact(phone: string): Promise<PatientProfile> {
  const { data: userData, error: userErr } = await supabase.auth.getUser()
  const user = userData.user
  if (userErr || !user) {
    throw new Error('You need to be logged in to update your profile.')
  }

  const canonical = toCanonicalPhilippineMobile(phone)
  if (!canonical) {
    throw new Error('Please enter a valid Philippine cellphone number.')
  }

  const { error } = await supabase.rpc('promote_default_phone_contact', { p_phone: canonical })
  if (error) {
    throw profilePromotionError(error, 'Could not update your default cellphone number. Please try again.')
  }

  return fetchMyProfile(user.id)
}

export async function promoteDefaultEmailContact(
  selectedEmailInput: string
): Promise<UpdateMyProfileResult> {
  const { data: userData, error: userErr } = await supabase.auth.getUser()
  const user = userData.user
  if (userErr || !user) {
    logDefaultEmailPromotionFailure('auth.getUser', userErr ?? new Error('missing authenticated user'))
    throw new Error('You need to be logged in to update your profile.')
  }

  const normalizedSelectedEmail = normalizeEmailForAuth(selectedEmailInput)
  logDefaultEmailPromotionState('normalize-selected-email', {
    selectedEmailLength: String(selectedEmailInput.length),
    normalizedSelectedEmailLength: String(normalizedSelectedEmail.length),
    normalizedSelectedEmailJson: JSON.stringify(normalizedSelectedEmail),
  })
  if (!normalizedSelectedEmail || !EMAIL_RE.test(normalizedSelectedEmail)) {
    throw new Error('Please enter a valid email address.')
  }

  const currentProfile = await fetchMyProfile(user.id)
  const currentPrimary = (currentProfile.email ?? '').trim().toLowerCase()

  if (normalizedSelectedEmail === currentPrimary) {
    const { error } = await supabase
      .from('profile_contacts')
      .delete()
      .eq('profile_id', user.id)
      .eq('contact_type', 'email')
      .eq('contact_value', normalizedSelectedEmail)

    if (error) {
      logDefaultEmailPromotionFailure('profile_contacts.cleanup_already_default', error)
      throw profilePromotionError(error, 'Could not update your default email. Please try again or contact MHO.')
    }

    return {
      profile: await fetchMyProfile(user.id),
      emailConfirmationRequired: false,
      emailAlreadyDefault: true,
    }
  }

  if (
    !currentProfile.additional_emails.some(
      (additionalEmail) => normalizeEmailForAuth(additionalEmail) === normalizedSelectedEmail
    )
  ) {
    throw new Error('That additional email is no longer available. Please refresh and try again.')
  }

  const updatePayload = { email: normalizedSelectedEmail }
  logDefaultEmailPromotionState('before-auth-update', {
    currentPrimary,
    selectedEmail: normalizedSelectedEmail,
    normalizedSelectedEmail,
    updateUserEmail: updatePayload.email,
    payloadMatchesSelected: updatePayload.email === normalizedSelectedEmail,
  })
  if (updatePayload.email !== normalizedSelectedEmail) {
    throw new Error('Default email promotion payload mismatch')
  }

  await callAuthenticatedFunction<{ success: boolean }>('promote-default-email', {
    selected_email: updatePayload.email,
  })

  return { profile: await fetchMyProfile(user.id), emailConfirmationRequired: false }
}

export async function updateMyProfile(
  input: UpdateMyProfileInput
): Promise<UpdateMyProfileResult> {
  const { data: userData, error: userErr } = await supabase.auth.getUser()
  const user = userData.user
  if (userErr || !user) {
    throw new Error('You need to be logged in to update your profile.')
  }

  const email = input.email.trim().toLowerCase()
  if (email && !EMAIL_RE.test(email)) {
    throw new Error('Please enter a valid email address.')
  }

  const phone = input.phone.trim()
  const canonicalPhone = phone ? toCanonicalPhilippineMobile(phone) : null
  if (phone && !canonicalPhone) {
    throw new Error('Enter a valid Philippine cellphone number. Example: 9094445123.')
  }

  let additionalEmails = uniqueNormalizedEmails(input.additionalEmails)
  for (const additionalEmail of additionalEmails) {
    if (!EMAIL_RE.test(additionalEmail)) {
      throw new Error('Please enter a valid additional email address.')
    }
  }
  const currentAuthEmail = (user.email ?? '').trim().toLowerCase()
  const emailChanged = email !== currentAuthEmail
  const primaryEmails = new Set([email, ...(emailChanged ? [] : [currentAuthEmail])].filter(Boolean))
  if (additionalEmails.some((additionalEmail) => primaryEmails.has(additionalEmail))) {
    throw new Error('Additional email must be different from your primary email.')
  }

  let additionalPhones = uniqueCanonicalPhones(input.additionalPhones)
  if (canonicalPhone && additionalPhones.includes(canonicalPhone)) {
    throw new Error('Additional contact number must be different from your primary number.')
  }

  let emailConfirmationRequired = false

  if (emailChanged) {
    if (!email) throw new Error('Email is required for login.')
    const { data: updateData, error: updateErr } = await supabase.auth.updateUser({ email })
    if (updateErr) throw new Error(errorMessage(updateErr, 'Could not update your email.'))

    const updatedEmail = (updateData.user?.email ?? '').trim().toLowerCase()
    emailConfirmationRequired = updatedEmail !== email
  }

  if (emailConfirmationRequired) {
    additionalEmails = uniqueNormalizedEmails([
      email,
      ...additionalEmails,
      ...(currentAuthEmail ? [currentAuthEmail] : []),
    ])
  } else {
    additionalEmails = additionalEmails.filter((additionalEmail) => additionalEmail !== email)
  }
  if (canonicalPhone) {
    additionalPhones = additionalPhones.filter((additionalPhone) => additionalPhone !== canonicalPhone)
  }

  const profilePatch: {
    phone: string | null
    email?: string | null
  } = {
    phone: canonicalPhone,
  }
  if (!emailChanged || !emailConfirmationRequired) profilePatch.email = email || null

  const { data, error } = await supabase
    .from('profiles')
    .update(profilePatch)
    .eq('id', user.id)
    .select('id, full_name, email, phone')
    .maybeSingle()

  if (error) throw new Error(errorMessage(error, 'Could not update your profile.'))
  if (!data) throw new Error('Your profile could not be updated.')

  const deleteContacts = await supabase.from('profile_contacts').delete().eq('profile_id', user.id)
  if (deleteContacts.error) {
    throw new Error(errorMessage(deleteContacts.error, 'Could not update your additional contacts.'))
  }

  const contactRows = [
    ...additionalEmails.map((contactValue) => ({
      profile_id: user.id,
      contact_type: 'email',
      contact_value: contactValue,
    })),
    ...additionalPhones.map((contactValue) => ({
      profile_id: user.id,
      contact_type: 'phone',
      contact_value: contactValue,
    })),
  ]

  if (contactRows.length > 0) {
    const insertContacts = await supabase.from('profile_contacts').insert(contactRows)
    if (insertContacts.error) {
      throw new Error(errorMessage(insertContacts.error, 'Could not save your additional contacts.'))
    }
  }

  return { profile: await fetchMyProfile(user.id), emailConfirmationRequired }
}

// The complete appointment record for the profile page: EVERY status
// (booked, checked_in, served, no_show, cancelled) so history is complete.
// RLS ("patient: select own appointments") scopes this to the caller. The
// caller sorts by slot_datetime for display; no server order is relied on.
export async function fetchMyAppointmentHistory(): Promise<Appointment[]> {
  const { data, error } = await supabase
    .from('appointments')
    .select(
      `
      id, status, service_id,
      services ( name ),
      providers ( profiles ( full_name ) ),
      time_slots ( slot_datetime ),
      queue_tickets ( ticket_number, queue_position, qr_code, status )
    `
    )
    .order('created_at', { ascending: false })

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return normalizeAppointments(data ?? [])
}
