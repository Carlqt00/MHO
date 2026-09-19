// ============================================================
// PASTE-READY BUNDLE for the Supabase Dashboard editor.
// Generated from supabase/functions/password-reset-request/index.ts with the _shared modules
// (cors.ts, sms.ts, reset-code.ts) inlined. Do not edit here — edit the
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

// ---- inlined from _shared/reset-code.ts ----
// Password-reset code hashing shared by password-reset-request (writes) and
// password-reset-complete (verifies).
//
// The code is only 6 digits, so it is hashed together with the request id:
// a leaked table row cannot be brute-forced offline without also knowing the
// id, and one code can never be replayed against another request.
export const RESET_CODE_LENGTH = 6
export const RESET_CODE_MAX_ATTEMPTS = 5

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function hashResetCode(requestId: string, code: string): Promise<string> {
  return sha256Hex(`${requestId}:${code}`)
}

export function isResetCode(value: string): boolean {
  return new RegExp(`^\d{${RESET_CODE_LENGTH}}$`).test(value)
}

// ---- password-reset-request/index.ts ----
// Public: start a password reset. The caller proves they know the account's
// full name + email + registered phone; if all three match ONE profile, a
// 6-digit code is texted to that phone and a reset request is stored with the
// code's hash. The code itself is NEVER returned to the browser — possession
// of the phone is the second factor. password-reset-complete consumes it.

const CODE_TTL_MINUTES = 15
// Don't text the same account again within this window even if the form is
// resubmitted — protects the SIM's per-recipient quota and the user's inbox.
const RESEND_COOLDOWN_SECONDS = 60

interface Body {
  email?: string
  fullName?: string
  phone?: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

// Uniformly random digits, leading zeros allowed. Rejection sampling keeps
// the distribution flat (a plain modulo would slightly favour low codes).
function randomCode(): string {
  const range = 10 ** RESET_CODE_LENGTH
  const limit = Math.floor(0x1_0000_0000 / range) * range
  let n: number
  do {
    n = crypto.getRandomValues(new Uint32Array(1))[0]
  } while (n >= limit)
  return (n % range).toString().padStart(RESET_CODE_LENGTH, '0')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Server is not configured correctly.' }, 500)
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Body
    const email = (body.email ?? '').trim().toLowerCase()
    const fullName = normalizeName(body.fullName ?? '')
    const phone = normalizePhilippineMobile(body.phone ?? '') ?? ''

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !fullName || !phone) {
      return json({ error: 'Valid account information is required.' }, 400)
    }

    const service = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: matches, error: lookupErr } = await service
      .from('profiles')
      .select('id, full_name, phone, email')
      .ilike('email', escapeLikePattern(email))
      .limit(5)

    if (lookupErr) {
      console.error('password-reset-request lookup failed:', lookupErr.message)
      return json({ error: 'Could not submit the request.' }, 500)
    }

    const comparisons = (matches ?? []).map((row) => ({
      row,
      emailMatch: (row.email ?? '').trim().toLowerCase() === email,
      nameMatch: normalizeName(row.full_name ?? '') === fullName,
      phoneMatch: (normalizePhilippineMobile(row.phone ?? '') ?? '') === phone,
    }))

    const matched = comparisons.find(
      (comparison) => comparison.emailMatch && comparison.nameMatch && comparison.phoneMatch
    )
    const profile = matched?.row

    if (!profile) {
      console.info('password-reset-request verification mismatch:', {
        email_match: comparisons.some((c) => c.emailMatch) || (matches ?? []).length > 0,
        name_match: comparisons.some((c) => c.nameMatch),
        phone_match: comparisons.some((c) => c.phoneMatch),
        candidate_count: matches?.length ?? 0,
      })
      return json({ verified: false })
    }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000).toISOString()

    // Expire stale approved requests for this profile so the partial unique
    // index (one pending/approved per profile) doesn't block a fresh one.
    await service
      .from('password_reset_requests')
      .update({ status: 'expired' })
      .eq('profile_id', profile.id)
      .eq('status', 'approved')
      .lt('token_expires_at', now.toISOString())

    const { data: existingRequest, error: existingErr } = await service
      .from('password_reset_requests')
      .select('id, approved_at')
      .eq('profile_id', profile.id)
      .in('status', ['pending', 'approved'])
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingErr) {
      console.error('password-reset-request active lookup failed:', existingErr.message)
      return json({ error: 'Could not submit the request.' }, 500)
    }

    // Resend cooldown: the previous code is still valid and was texted moments
    // ago — tell the browser to use it rather than sending another SMS.
    if (existingRequest?.approved_at) {
      const ageSeconds = (now.getTime() - Date.parse(existingRequest.approved_at)) / 1000
      if (ageSeconds >= 0 && ageSeconds < RESEND_COOLDOWN_SECONDS) {
        return json({
          verified: true,
          requestId: existingRequest.id,
          phoneHint: maskPhilippineMobile(phone),
          smsSent: true,
          resent: false,
        })
      }
    }

    // Reserve the request row first (we need its id to salt the code hash).
    let requestId = existingRequest?.id as string | undefined
    if (!requestId) {
      const { data: inserted, error: insertErr } = await service
        .from('password_reset_requests')
        .insert({
          profile_id: profile.id,
          status: 'pending',
          requested_at: now.toISOString(),
        })
        .select('id')
        .single()
      if (insertErr || !inserted) {
        console.error('password-reset-request insert failed:', insertErr?.message)
        return json({ error: 'Could not submit the request.' }, 500)
      }
      requestId = inserted.id as string
    }

    const code = randomCode()
    const tokenHash = await hashResetCode(requestId, code)

    const { error: approveErr } = await service
      .from('password_reset_requests')
      .update({
        status: 'approved',
        approved_at: now.toISOString(),
        requested_at: now.toISOString(),
        processed_at: null,
        processed_by: null,
        completed_at: null,
        token_hash: tokenHash,
        token_expires_at: expiresAt,
        token_used_at: null,
        code_attempts: 0,
      })
      .eq('id', requestId)

    if (approveErr) {
      console.error('password-reset-request approval update failed:', approveErr.message)
      return json({ error: 'Could not submit the request.' }, 500)
    }

    // Text the code. If the gateway is down, void this request (so the next
    // attempt isn't swallowed by the resend cooldown) and tell the user plainly.
    // The failed row stays visible to admins on Password Resets.
    let smsSent = true
    try {
      await sendSms(service, {
        event: 'password_reset_code',
        recipient: phone,
        message: `${SMS_SENDER_PREFIX}: Your password reset code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes. If you did not request this, ignore this message.`,
      })
    } catch (err) {
      smsSent = false
      console.error(
        'password-reset-request SMS failed:',
        err instanceof HttpError ? err.message : err
      )
      await service
        .from('password_reset_requests')
        .update({ status: 'failed', token_hash: null, token_expires_at: null })
        .eq('id', requestId)
    }

    await service.from('audit_log').insert({
      actor_id: profile.id,
      action: smsSent ? 'password_reset_code_sent' : 'password_reset_code_sms_failed',
      target_table: 'password_reset_requests',
      target_id: requestId,
    })

    return json({
      verified: true,
      requestId,
      expiresAt,
      phoneHint: maskPhilippineMobile(phone),
      smsSent,
      resent: true,
    })
  } catch (err) {
    console.error('password-reset-request unexpected error:', err)
    return json({ error: 'Unexpected server error.' }, 500)
  }
})
