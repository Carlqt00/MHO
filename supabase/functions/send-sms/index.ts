import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

type SmsEvent = 'appointment_booked' | 'appointment_cancelled'
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
    profiles: {
      phone: string | null
    } | null
  } | null
  services: {
    name: string
  } | null
  time_slots: {
    slot_datetime: string
  } | null
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function isSmsEvent(value: string): value is SmsEvent {
  return value === 'appointment_booked' || value === 'appointment_cancelled'
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  )
}

function isCanonicalPhilippineMobile(value: string): boolean {
  return /^\+639\d{9}$/.test(value)
}

function normalizePhilippineMobile(value: string): string | null {
  let digits = value.replace(/\D/g, '')
  if (digits.startsWith('63')) digits = digits.slice(2)
  else if (digits.startsWith('0')) digits = digits.slice(1)
  digits = digits.slice(0, 10)
  return /^9\d{9}$/.test(digits) ? `+63${digits}` : null
}

function appointmentInstant(appointment: AppointmentDetails): string | null {
  return appointment.appointment_at ?? appointment.time_slots?.slot_datetime ?? null
}

function formatAppointmentTime(iso: string): string {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function messageFor(event: SmsEvent, appointment: AppointmentDetails): string {
  const when = appointmentInstant(appointment)
  if (event === 'appointment_booked') {
    return when
      ? `MHO Malilipot: Your appointment is booked for ${formatAppointmentTime(when)}.`
      : 'MHO Malilipot: Your appointment has been booked successfully.'
  }

  return when
    ? `MHO Malilipot: Your appointment for ${formatAppointmentTime(when)} has been cancelled.`
    : 'MHO Malilipot: Your appointment has been cancelled.'
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim()
  if (!value) throw new HttpError(500, 'SMS service is not configured.')
  return value
}

function parseResponseBody(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
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
      time_slots ( slot_datetime )
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

function authorize(callerId: string, role: Role, appointment: AppointmentDetails): void {
  const ownerId = appointment.patients?.profile_id
  if (ownerId === callerId) return
  if (role === 'staff' || role === 'admin') return
  throw new HttpError(403, 'You are not allowed to send SMS for this appointment.')
}

async function createPendingLog(
  service: SupabaseClient,
  input: {
    recipient: string
    message: string
    patientId?: string | null
    appointmentId?: string | null
  }
): Promise<string> {
  const { data, error } = await service
    .from('notification_logs')
    .insert({
      type: 'sms',
      recipient: input.recipient,
      message: input.message,
      status: 'pending',
      patient_id: input.patientId ?? null,
      appointment_id: input.appointmentId ?? null,
    })
    .select('id')
    .single()

  if (error) {
    console.error('send-sms notification log insert failed:', error.message)
    throw new HttpError(500, 'Could not record the SMS notification attempt.')
  }

  return data.id as string
}

async function markLogSent(service: SupabaseClient, logId: string): Promise<void> {
  const { error } = await service
    .from('notification_logs')
    .update({ status: 'sent', sent_at: new Date().toISOString(), error_message: null })
    .eq('id', logId)

  if (error) console.error('send-sms notification log sent update failed:', error.message)
}

async function markLogFailed(
  service: SupabaseClient,
  logId: string,
  safeError: string
): Promise<void> {
  const { error } = await service
    .from('notification_logs')
    .update({ status: 'failed', error_message: safeError })
    .eq('id', logId)

  if (error) console.error('send-sms notification log failed update failed:', error.message)
}

async function sendViaITextMo(
  service: SupabaseClient,
  logId: string,
  phone: string,
  smsBody: string
): Promise<{ httpStatus: number; responseBody: unknown }> {
  if (!isCanonicalPhilippineMobile(phone)) {
    const safeError = 'No usable Philippine mobile number is available.'
    await markLogFailed(service, logId, safeError)
    throw new HttpError(422, safeError)
  }

  let apiKey = ''
  let endpoint = ''

  try {
    apiKey = requiredEnv('ITEXTMO_API_KEY')
    endpoint = requiredEnv('ITEXTMO_ENDPOINT')
  } catch (err) {
    const safeError = err instanceof HttpError ? err.message : 'SMS service is not configured.'
    await markLogFailed(service, logId, safeError)
    throw err
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
          'Idempotency-Key': `mho-${logId}`,
        },
        body: JSON.stringify({
          to: phone,
          body: smsBody,
        }),
      })
    } finally {
      clearTimeout(timeoutId)
    }

    const debugBody = await response.clone().text()

    console.log('iTextMo gateway response debug:', {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      redirected: response.redirected,
      contentType: response.headers.get('content-type'),
      server: response.headers.get('server'),
      location: response.headers.get('location'),
      body: debugBody,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.error('send-sms iTextMo request timed out after 15 seconds')
      const safeError = 'SMS gateway request timed out.'
      await markLogFailed(service, logId, safeError)
      throw new HttpError(504, 'SMS notification timed out.')
    }

    console.error('send-sms iTextMo request failed before response:', err)
    const safeError = 'SMS gateway request failed.'
    await markLogFailed(service, logId, safeError)
    throw new HttpError(502, 'SMS notification could not be sent.')
  }

  const responseText = await response.text()
  const responseBody = parseResponseBody(responseText)

  if (!response.ok) {
    console.error('send-sms iTextMo request failed:', {
      status: response.status,
      notification_log_id: logId,
    })
    const safeError = `SMS gateway returned HTTP ${response.status}.`
    await markLogFailed(service, logId, safeError)
    throw new HttpError(502, 'SMS notification could not be sent.')
  }

  await markLogSent(service, logId)
  return { httpStatus: response.status, responseBody }
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

    if (!event && (manualRecipient || manualMessage)) {
      if (role !== 'admin') return json({ error: 'Administrator access required.' }, 403)
      if (!manualRecipient) return json({ error: 'Recipient phone number is required.' }, 400)
      if (!manualMessage) return json({ error: 'Message is required.' }, 400)
      if (manualMessage.length > 480) {
        return json({ error: 'Message is too long. Please keep it under 480 characters.' }, 400)
      }

      const phone = normalizePhilippineMobile(manualRecipient) ?? manualRecipient
      const logId = await createPendingLog(service, {
        recipient: phone,
        message: manualMessage,
      })
      const result = await sendViaITextMo(service, logId, phone, manualMessage)

      return json({
        success: true,
        notification_log_id: logId,
        http_status: result.httpStatus,
        response: result.responseBody,
      })
    }

    if (!isSmsEvent(event)) return json({ error: 'Unsupported SMS event.' }, 400)
    if (!isUuid(appointmentId)) return json({ error: 'Valid appointment id is required.' }, 400)

    const appointment = await fetchAppointment(service, appointmentId)
    authorize(callerId, role, appointment)

    if (event === 'appointment_booked' && appointment.status !== 'booked') {
      return json({ error: 'Appointment is not in a bookable notification state.' }, 400)
    }
    if (event === 'appointment_cancelled' && appointment.status !== 'cancelled') {
      return json({ error: 'Appointment is not cancelled.' }, 400)
    }

    const phone = appointment.patients?.profiles?.phone ?? ''
    const smsBody = messageFor(event, appointment)
    const logId = await createPendingLog(service, {
      recipient: phone,
      message: smsBody,
      patientId: appointment.patient_id,
      appointmentId: appointment.id,
    })
    const result = await sendViaITextMo(service, logId, phone, smsBody)

    return json({
      success: true,
      notification_log_id: logId,
      http_status: result.httpStatus,
      response: result.responseBody,
    })
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('send-sms unexpected error:', err)
    return json({ error: 'Unexpected server error.' }, 500)
  }
})
