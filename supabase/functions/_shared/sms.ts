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
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

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
