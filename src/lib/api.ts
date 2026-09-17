import { supabase } from './supabase'
import { errorMessage } from './errors'
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
  services: { name: string }
  providers: { profiles: { full_name: string } }
  time_slots: { slot_datetime: string }
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
      id, slot_datetime,
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

export interface DaySlotStatus {
  day: string // 'YYYY-MM-DD' (Asia/Manila)
  remaining: number // unbooked AND upcoming — actually bookable now
  unbooked: number // unbooked, any time (past + upcoming)
  upcoming: number // any slot with slot_datetime >= now() (booked or not)
  total: number // every non-exception slot that day (booked + unbooked)
}

// ONE aggregate query for the month calendar (service_daily_slot_status, 0013):
// per-Manila-day slot counts for a service across every provider offering it.
// from/to are inclusive Manila dates ('YYYY-MM-DD'). Days with NO non-exception
// slot are simply absent from the result — the calendar reads that as
// "Walang schedule". Supersedes the open-count-only service_daily_availability
// (0011) so the calendar can tell "no schedule" / "full" / "times passed" apart.
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
  service_id: string
  slot_datetime: string
}

// The caller's own active (non-cancelled) bookings, for client-side conflict
// pre-checks before submit. RLS scopes this to the current patient.
export async function fetchMyActiveBookings(): Promise<ActiveBooking[]> {
  const { data, error } = await supabase
    .from('appointments')
    .select('service_id, time_slots!inner ( slot_datetime )')
    .not('status', 'eq', 'cancelled')

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return (
    (data ?? []) as unknown as {
      service_id: string
      time_slots: { slot_datetime: string }
    }[]
  ).map((row) => ({
    service_id: row.service_id,
    slot_datetime: row.time_slots.slot_datetime,
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

export type AppointmentSmsEvent = 'appointment_booked' | 'appointment_cancelled'

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

export type NotificationStatus = 'pending' | 'sent' | 'failed'
export type NotificationType = 'sms' | 'email'

export interface NotificationLog {
  id: string
  type: NotificationType
  recipient: string
  message: string
  status: NotificationStatus
  created_at: string
  sent_at: string | null
  error_message: string | null
}

export interface NotificationSummary {
  sent: number
  pending: number
  failed: number
}

export async function fetchNotificationLogs(
  status: NotificationStatus | 'all' = 'all'
): Promise<NotificationLog[]> {
  let query = supabase
    .from('notification_logs')
    .select('id, type, recipient, message, status, created_at, sent_at, error_message')
    .order('created_at', { ascending: false })
    .limit(100)

  if (status !== 'all') query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw new Error(errorMessage(error, 'Failed to load notification logs.'))
  return data as NotificationLog[]
}

export async function fetchNotificationSummary(): Promise<NotificationSummary> {
  const [sent, pending, failed] = await Promise.all([
    supabase
      .from('notification_logs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'sent'),
    supabase
      .from('notification_logs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
    supabase
      .from('notification_logs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed'),
  ])

  for (const result of [sent, pending, failed]) {
    if (result.error) throw new Error(errorMessage(result.error, 'Failed to load notification totals.'))
  }

  return {
    sent: sent.count ?? 0,
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
    services: { name: string }
    patients: { profiles: { full_name: string } }
    providers: { profiles: { full_name: string } }
    time_slots: { slot_datetime: string }
  }
}

// Today's date window in Asia/Manila, as UTC ISO strings
function manilaDayWindow(): { start: string; end: string } {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
  return {
    start: new Date(`${today}T00:00:00+08:00`).toISOString(),
    end: new Date(`${today}T23:59:59+08:00`).toISOString(),
  }
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
    .neq('appointments.status', 'cancelled')
    .gte('appointments.time_slots.slot_datetime', start)
    .lte('appointments.time_slots.slot_datetime', end)
    .order('queue_position')

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return data as unknown as QueueTicket[]
}

export interface AdvanceResult {
  ticket_id: string
  ticket_number: string
  queue_position: number
}

export async function advanceQueue(providerId: string): Promise<AdvanceResult | null> {
  const { data, error } = await supabase.rpc('advance_queue', { p_provider_id: providerId })
  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return data as AdvanceResult | null
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
    if (import.meta.env.DEV) {
      const context = (error as { context?: unknown }).context
      const status = context instanceof Response ? context.status : undefined
      let responseBody = ''
      if (context instanceof Response) {
        try {
          responseBody = await context.clone().text()
        } catch {
          responseBody = ''
        }
      }
      console.error(`${name} failed`, {
        message: error.message,
        status,
        responseBody,
      })
    }
    throw new Error(errorMessage(error, GENERIC_ERR))
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

export async function submitPasswordResetRequest(input: {
  email: string
  fullName: string
  phone: string
}): Promise<{ verified: boolean; resetToken?: string; expiresAt?: string }> {
  const body = {
    email: input.email.trim().toLowerCase(),
    fullName: input.fullName.trim(),
    phone: input.phone.trim(),
  }
  if (import.meta.env.DEV) {
    console.info('password-reset-request browser payload', JSON.stringify({
      full_name: body.fullName,
      phone: body.phone,
      email: body.email,
    }))
  }
  const result = await callPublicFunction<{
    verified: boolean
    resetToken?: string
    expiresAt?: string
  }>('password-reset-request', body)
  if (import.meta.env.DEV) {
    console.info('password-reset-request browser response', JSON.stringify({
      verified: result.verified,
      hasResetToken: typeof result.resetToken === 'string' && result.resetToken.length > 0,
      hasExpiresAt: typeof result.expiresAt === 'string' && result.expiresAt.length > 0,
    }))
  }
  return result
}

export async function completePasswordReset(input: {
  resetToken: string
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
        'May availability window na para sa araw at oras na ito. Pumili ng ibang oras. / An availability window for that day and start time already exists.'
      )
    }
    if (error.code === '23514') {
      throw new Error(
        'Dapat mas huli ang oras ng pagtatapos kaysa sa pagsisimula. / The end time must be after the start time.'
      )
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
        'May exception date na para sa napiling provider at petsa. / An exception date is already set for that provider and date.'
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

// ------------------------------------------------------------
// Announcements
// ------------------------------------------------------------
export interface Announcement {
  id: string
  title: string
  body: string
  published: boolean
  created_at: string
}

// Admin list — the "admin: manage announcements" policy is FOR ALL, so admins
// can read drafts as well as published rows.
export async function fetchAllAnnouncements(): Promise<Announcement[]> {
  const { data, error } = await supabase
    .from('announcements')
    .select('id, title, body, published, created_at')
    .order('created_at', { ascending: false })

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  return data as Announcement[]
}

// Public feed — RLS already limits anon/authenticated to published rows; the
// explicit filter also keeps an admin's feed view to published only.
export async function fetchPublishedAnnouncements(): Promise<Announcement[]> {
  const { data, error } = await supabase
    .from('announcements')
    .select('id, title, body, published, created_at')
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
    return 'Hindi wasto ang interval — dapat 5 hanggang 480 minuto. / Interval must be between 5 and 480 minutes.'
  if (raw.includes('ERR_INVALID_RANGE'))
    return 'Ang "from" na petsa ay dapat mas maaga o katulad ng "to" na petsa. / The from-date must be on or before the to-date.'
  if (raw.includes('ERR_RANGE_TOO_LARGE'))
    return 'Masyadong malaki ang saklaw ng petsa — hindi lalampas sa 180 araw. / The date range cannot exceed 180 days.'
  if (raw.includes('ERR_NOT_FOUND'))
    return 'Hindi mahanap ang napiling provider o serbisyo. / The selected provider or service was not found.'
  if (raw.includes('ERR_FORBIDDEN'))
    return 'Administrator lang ang maaaring mag-generate ng slots. / Only an administrator can generate slots.'
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
      id, status,
      services ( name ),
      providers ( profiles ( full_name ) ),
      time_slots ( slot_datetime ),
      queue_tickets ( ticket_number, queue_position, qr_code, status )
    `
    )
    .not('status', 'eq', 'cancelled')
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
      id, status,
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
  full_name: string
  email: string | null
  phone: string | null
}

// Read-only basic profile info. RLS ("own profile: select") already limits a
// patient to their own row; the explicit id filter keeps the read to one row.
export async function fetchMyProfile(userId: string): Promise<PatientProfile> {
  const { data, error } = await supabase
    .from('profiles')
    .select('full_name, email, phone')
    .eq('id', userId)
    .maybeSingle()

  if (error) throw new Error(errorMessage(error, GENERIC_ERR))
  if (!data) throw new Error('Hindi mahanap ang iyong profile. / Your profile could not be found.')
  return data as PatientProfile
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
      id, status,
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
