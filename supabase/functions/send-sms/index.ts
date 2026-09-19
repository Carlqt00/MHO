import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import {
  HttpError,
  MAX_SMS_LENGTH,
  SMS_SENDER_PREFIX,
  formatAppointmentTime,
  normalizePhilippineMobile,
  sendSms,
} from '../_shared/sms.ts'

// Appointment-lifecycle events the client may ask us to text about. The
// message text is composed HERE from the appointment row — the client never
// supplies message content for these, so a caller can only trigger the
// notification that matches the appointment's real state.
const APPOINTMENT_EVENTS = [
  'appointment_booked',
  'appointment_cancelled',
  'appointment_rescheduled',
  'appointment_checked_in',
  'appointment_served',
  'appointment_no_show',
  'queue_now_serving',
] as const
type SmsEvent = (typeof APPOINTMENT_EVENTS)[number]

// Which appointment status each event is valid for. Prevents e.g. texting
// "your appointment is booked" for a cancelled row.
const EXPECTED_STATUS: Record<SmsEvent, string[]> = {
  appointment_booked: ['booked'],
  appointment_cancelled: ['cancelled'],
  appointment_rescheduled: ['booked'],
  appointment_checked_in: ['checked_in'],
  appointment_served: ['served'],
  appointment_no_show: ['no_show'],
  queue_now_serving: ['booked', 'checked_in'],
}

// Events a PATIENT may trigger for their own appointment. Everything else is
// clinic personnel only (they are the ones performing those actions).
const PATIENT_EVENTS: SmsEvent[] = [
  'appointment_booked',
  'appointment_cancelled',
  'appointment_rescheduled',
]

type Role = 'patient' | 'doctor' | 'nurse' | 'staff' | 'admin'

interface Body {
  event?: string
  appointment_id?: string
  recipient?: string
  message?: string
}

interface AppointmentDetails {
  id: string
  status: string
  appointment_at: string | null
  patient_id: string
  patients: {
    profile_id: string
    profiles: { phone: string | null } | null
  } | null
  services: { name: string } | null
  providers: { profiles: { full_name: string } | null } | null
  time_slots: { slot_datetime: string } | null
  queue_tickets: { ticket_number: string; status: string } | { ticket_number: string; status: string }[] | null
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function isSmsEvent(value: string): value is SmsEvent {
  return (APPOINTMENT_EVENTS as readonly string[]).includes(value)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function appointmentInstant(appointment: AppointmentDetails): string | null {
  return appointment.appointment_at ?? appointment.time_slots?.slot_datetime ?? null
}

function ticketOf(appointment: AppointmentDetails): { ticket_number: string; status: string } | null {
  const t = appointment.queue_tickets
  if (!t) return null
  return Array.isArray(t) ? (t[0] ?? null) : t
}

function messageFor(event: SmsEvent, appointment: AppointmentDetails): string {
  const when = appointmentInstant(appointment)
  const whenText = when ? formatAppointmentTime(when) : null
  const service = appointment.services?.name ?? 'your appointment'
  const provider = appointment.providers?.profiles?.full_name
  const ticket = ticketOf(appointment)?.ticket_number
  const p = SMS_SENDER_PREFIX

  switch (event) {
    case 'appointment_booked':
      return whenText
        ? `${p}: Your ${service} appointment is booked for ${whenText}${ticket ? ` (Ticket ${ticket})` : ''}. Please arrive 15 minutes early.`
        : `${p}: Your ${service} appointment has been booked successfully.`
    case 'appointment_cancelled':
      return whenText
        ? `${p}: Your ${service} appointment for ${whenText} has been cancelled.`
        : `${p}: Your ${service} appointment has been cancelled.`
    case 'appointment_rescheduled':
      return whenText
        ? `${p}: Your ${service} appointment has been moved to ${whenText}${provider ? ` with ${provider}` : ''}${ticket ? ` (Ticket ${ticket})` : ''}. Please arrive 15 minutes early.`
        : `${p}: Your ${service} appointment has been rescheduled.`
    case 'appointment_checked_in':
      return `${p}: You are checked in for ${service}${ticket ? `. Your ticket is ${ticket}` : ''}. Please wait to be called.`
    case 'queue_now_serving':
      return `${p}: It's your turn${ticket ? ` — Ticket ${ticket}` : ''}. Please proceed to ${provider ?? 'the clinic'} now.`
    case 'appointment_served':
      return `${p}: Thank you for visiting today. Your ${service} appointment is complete. Ingat po!`
    case 'appointment_no_show':
      return whenText
        ? `${p}: You missed your ${service} appointment on ${whenText}. Please book a new appointment when you are able.`
        : `${p}: You missed your ${service} appointment. Please book a new appointment when you are able.`
  }
}

async function authenticatedContext(req: Request): Promise<{
  callerId: string
  role: Role
  service: SupabaseClient
}> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !anonKey || !serviceKey) {
    throw new HttpError(500, 'Server is not configured correctly.')
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new HttpError(401, 'Missing authorization token.')

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userErr } = await authClient.auth.getUser()
  if (userErr || !userData?.user) throw new HttpError(401, 'Invalid or expired session.')

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: profile, error: profileErr } = await service
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle()

  if (profileErr) throw new HttpError(500, 'Could not verify your permissions.')
  if (!profile) throw new HttpError(403, 'Profile not found.')

  return { callerId: userData.user.id, role: profile.role as Role, service }
}

async function fetchAppointment(
  service: SupabaseClient,
  appointmentId: string
): Promise<AppointmentDetails> {
  const { data, error } = await service
    .from('appointments')
    .select(
      `
      id, status, appointment_at, patient_id,
      patients!inner (
        profile_id,
        profiles!inner ( phone )
      ),
      services ( name ),
      providers ( profiles ( full_name ) ),
      time_slots ( slot_datetime ),
      queue_tickets ( ticket_number, status )
    `
    )
    .eq('id', appointmentId)
    .maybeSingle()

  if (error) {
    console.error('send-sms appointment lookup failed:', error.message)
    throw new HttpError(500, 'Could not load the appointment.')
  }
  if (!data) throw new HttpError(404, 'Appointment not found.')

  return data as unknown as AppointmentDetails
}

function authorize(callerId: string, role: Role, event: SmsEvent, appointment: AppointmentDetails) {
  if (role === 'staff' || role === 'admin' || role === 'nurse') return
  const ownerId = appointment.patients?.profile_id
  if (role === 'patient' && ownerId === callerId && PATIENT_EVENTS.includes(event)) return
  throw new HttpError(403, 'You are not allowed to send SMS for this appointment.')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  try {
    const { callerId, role, service } = await authenticatedContext(req)
    const body = (await req.json().catch(() => ({}))) as Body
    const event = (body.event ?? '').trim()
    const appointmentId = (body.appointment_id ?? '').trim()
    const manualRecipient = (body.recipient ?? '').trim()
    const manualMessage = (body.message ?? '').trim()

    // ── Manual admin SMS (free text) ─────────────────────────
    if (!event && (manualRecipient || manualMessage)) {
      if (role !== 'admin') return json({ error: 'Administrator access required.' }, 403)
      if (!manualRecipient) return json({ error: 'Recipient phone number is required.' }, 400)
      if (!manualMessage) return json({ error: 'Message is required.' }, 400)
      if (manualMessage.length > MAX_SMS_LENGTH) {
        return json(
          { error: `Message is too long. Please keep it under ${MAX_SMS_LENGTH} characters.` },
          400
        )
      }

      const phone = normalizePhilippineMobile(manualRecipient) ?? manualRecipient
      const result = await sendSms(service, {
        event: 'manual',
        recipient: phone,
        message: manualMessage,
      })

      return json({
        success: true,
        notification_log_id: result.logId,
        http_status: result.httpStatus,
        response: result.responseBody,
      })
    }

    // ── Appointment lifecycle events ─────────────────────────
    if (!isSmsEvent(event)) return json({ error: 'Unsupported SMS event.' }, 400)
    if (!isUuid(appointmentId)) return json({ error: 'Valid appointment id is required.' }, 400)

    const appointment = await fetchAppointment(service, appointmentId)
    authorize(callerId, role, event, appointment)

    if (!EXPECTED_STATUS[event].includes(appointment.status)) {
      return json({ error: 'Appointment is not in a state that matches this notification.' }, 400)
    }
    if (event === 'queue_now_serving' && ticketOf(appointment)?.status !== 'now_serving') {
      return json({ error: 'This ticket is not currently being served.' }, 400)
    }

    const phone = appointment.patients?.profiles?.phone ?? ''
    const result = await sendSms(service, {
      event,
      recipient: phone,
      message: messageFor(event, appointment),
      patientId: appointment.patient_id,
      appointmentId: appointment.id,
    })

    return json({
      success: true,
      notification_log_id: result.logId,
      http_status: result.httpStatus,
      response: result.responseBody,
    })
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('send-sms unexpected error:', err)
    return json({ error: 'Unexpected server error.' }, 500)
  }
})
