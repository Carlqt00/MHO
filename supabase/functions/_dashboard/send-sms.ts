// ============================================================
// PASTE-READY BUNDLE for the Supabase Dashboard editor.
// Generated from supabase/functions/send-sms/index.ts with the _shared modules
// (cors.ts, sms.ts) inlined. Do not edit here — edit the
// source files and re-run scratchpad bundle.js. CLI deploys use the originals.
// ============================================================
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

// ---- inlined from _shared/cors.ts ----
// CORS headers for browser calls. Auth is carried in the Authorization
// bearer header (not cookies), so a wildcard origin is safe here — no
// credentialed requests. Tighten to your app origin if you prefer.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ---- inlined from _shared/sms.ts ----
// Shared iTextMo SMS gateway used by every Edge Function that sends a text.
//
// iTextMo (https://itextmo.netlify.app/documentation) is a one-SIM gateway:
//   POST https://api.itextmo.com/v1/messages
//   Authorization: Bearer <key>   Idempotency-Key: <8-128 chars>
//   { "to": "+639…", "body": "…", "client_ref": "…" }  →  202 { data: { id, status, segments } }
// 202 means "queued", not delivered. Delivery outcome arrives on the
// itextmo-webhook function, which matches our notification_logs row by the
// provider message id we store here.
//
// The MHO handset is paired to a per-device backend that implements the same
// contract under a different host — set ITEXTMO_ENDPOINT to its full messages
// URL (currently https://itextmo-backend-dev.vercel.app/api/v1/messages).
// Verified 2026-09-19: Bearer key auth; Idempotency-Key is REQUIRED; unknown
// body fields are rejected (so never add fields beyond to/body/client_ref).
//
// Every send writes a notification_logs row FIRST (status 'pending'), then
// flips it to 'sent' or 'failed'. Only safe, generic error text is stored —
// never the gateway's raw response.

export const DEFAULT_ITEXTMO_ENDPOINT = 'https://api.itextmo.com/v1/messages'

// iTextMo accepts up to 1600 chars (6 segments); we cap lower so a single
// notification never burns more than ~3 segments of a metered SIM plan.
export const MAX_SMS_LENGTH = 480

export const SMS_SENDER_PREFIX = 'MHO Malilipot'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function isCanonicalPhilippineMobile(value: string): boolean {
  return /^\+639\d{9}$/.test(value)
}

export function normalizePhilippineMobile(value: string): string | null {
  let digits = value.replace(/\D/g, '')
  if (digits.startsWith('63')) digits = digits.slice(2)
  else if (digits.startsWith('0')) digits = digits.slice(1)
  digits = digits.slice(0, 10)
  return /^9\d{9}$/.test(digits) ? `+63${digits}` : null
}

// "+639171234567" → "+63•••••••4567" — safe to show on a public page.
export function maskPhilippineMobile(value: string): string {
  if (!isCanonicalPhilippineMobile(value)) return ''
  return `+63${'•'.repeat(6)}${value.slice(-4)}`
}

export function formatAppointmentTime(iso: string): string {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function parseResponseBody(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function providerMessageId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const data = (body as { data?: unknown }).data
  if (data && typeof data === 'object') {
    const id = (data as { id?: unknown }).id
    if (typeof id === 'string' && id) return id
  }
  const id = (body as { id?: unknown }).id
  return typeof id === 'string' && id ? id : null
}

export interface SendSmsInput {
  recipient: string
  message: string
  event: string
  patientId?: string | null
  appointmentId?: string | null
  announcementId?: string | null
}

export interface SendSmsResult {
  logId: string
  httpStatus: number
  providerMessageId: string | null
  responseBody: unknown
}

async function createPendingLog(service: SupabaseClient, input: SendSmsInput): Promise<string> {
  const { data, error } = await service
    .from('notification_logs')
    .insert({
      type: 'sms',
      event: input.event,
      recipient: input.recipient,
      message: input.message,
      status: 'pending',
      patient_id: input.patientId ?? null,
      appointment_id: input.appointmentId ?? null,
      announcement_id: input.announcementId ?? null,
    })
    .select('id')
    .single()

  if (error) {
    console.error('sms: notification log insert failed:', error.message)
    throw new HttpError(500, 'Could not record the SMS notification attempt.')
  }
  return data.id as string
}

async function markLogSent(
  service: SupabaseClient,
  logId: string,
  providerId: string | null
): Promise<void> {
  const { error } = await service
    .from('notification_logs')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      error_message: null,
      provider_message_id: providerId,
    })
    .eq('id', logId)
  if (error) console.error('sms: notification log sent update failed:', error.message)
}

async function markLogFailed(service: SupabaseClient, logId: string, safeError: string) {
  const { error } = await service
    .from('notification_logs')
    .update({ status: 'failed', error_message: safeError })
    .eq('id', logId)
  if (error) console.error('sms: notification log failed update failed:', error.message)
}

// Map iTextMo's documented error codes to short operator-readable reasons.
function gatewayFailureReason(status: number, body: unknown): string {
  const code =
    body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string'
      ? (body as { code: string }).code
      : body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : ''
  switch (code) {
    case 'RECIPIENT_BLOCKED':
      return 'Recipient opted out (STOP) or is blocklisted.'
    case 'INVALID_RECIPIENT':
      return 'Gateway rejected the mobile number.'
    case 'MESSAGE_TOO_LONG':
      return 'Message exceeds the gateway length limit.'
    case 'QUEUE_FULL':
      return 'Gateway queue is full — handset is not draining.'
    case 'RATE_LIMITED':
      return 'Gateway rate limit hit; try again shortly.'
    case 'INVALID_CREDENTIALS':
      return 'Gateway rejected the API key.'
    case 'DEVICE_SUSPENDED':
      return 'Gateway device is suspended.'
    default:
      return `SMS gateway returned HTTP ${status}${code ? ` (${code})` : ''}.`
  }
}

// Logs + sends ONE SMS. Throws HttpError on failure (after marking the log
// failed) so callers can decide whether the failure is fatal for them.
export async function sendSms(service: SupabaseClient, input: SendSmsInput): Promise<SendSmsResult> {
  const logId = await createPendingLog(service, input)

  if (!isCanonicalPhilippineMobile(input.recipient)) {
    const safeError = 'No usable Philippine mobile number is available.'
    await markLogFailed(service, logId, safeError)
    throw new HttpError(422, safeError)
  }
  if (!input.message.trim()) {
    await markLogFailed(service, logId, 'Message is empty.')
    throw new HttpError(400, 'Message is required.')
  }
  if (input.message.length > MAX_SMS_LENGTH) {
    const safeError = `Message is too long. Please keep it under ${MAX_SMS_LENGTH} characters.`
    await markLogFailed(service, logId, safeError)
    throw new HttpError(400, safeError)
  }

  const apiKey = Deno.env.get('ITEXTMO_API_KEY')?.trim()
  const endpoint = Deno.env.get('ITEXTMO_ENDPOINT')?.trim() || DEFAULT_ITEXTMO_ENDPOINT
  if (!apiKey) {
    const safeError = 'SMS service is not configured.'
    await markLogFailed(service, logId, safeError)
    throw new HttpError(500, safeError)
  }

  let response: Response
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // Required by the gateway (8–128 chars of [A-Za-z0-9_:.-]); a retry
          // within 24h replays the original 202 instead of texting twice.
          'Idempotency-Key': `mho-${logId}`,
        },
        body: JSON.stringify({
          to: input.recipient,
          body: input.message,
          client_ref: logId,
        }),
      })
    } finally {
      clearTimeout(timeoutId)
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.error('sms: iTextMo request timed out after 15 seconds')
      await markLogFailed(service, logId, 'SMS gateway request timed out.')
      throw new HttpError(504, 'SMS notification timed out.')
    }
    console.error('sms: iTextMo request failed before response:', err)
    await markLogFailed(service, logId, 'SMS gateway request failed.')
    throw new HttpError(502, 'SMS notification could not be sent.')
  }

  const responseText = await response.text()
  const responseBody = parseResponseBody(responseText)

  if (!response.ok) {
    console.error('sms: iTextMo request failed:', {
      status: response.status,
      notification_log_id: logId,
      body: responseText.slice(0, 500),
    })
    await markLogFailed(service, logId, gatewayFailureReason(response.status, responseBody))
    throw new HttpError(502, 'SMS notification could not be sent.')
  }

  const providerId = providerMessageId(responseBody)
  await markLogSent(service, logId, providerId)
  return { logId, httpStatus: response.status, providerMessageId: providerId, responseBody }
}

// ---- send-sms/index.ts ----
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
