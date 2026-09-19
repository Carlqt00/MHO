// ============================================================
// PASTE-READY BUNDLE for the Supabase Dashboard editor.
// Generated from supabase/functions/send-announcement-sms/index.ts with the _shared modules
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

// ---- send-announcement-sms/index.ts ----
// Admin-only: broadcast ONE published announcement by SMS to every patient
// with a usable Philippine mobile number.
//
// The gateway is a single SIM draining ~1 msg/sec with a 1000-message queue
// and a 2000/day quota, so this is deliberately an explicit action (a button
// with a recipient count), never a side effect of publishing.
//
// Resumable: patients who already have a 'sent'/'delivered' log for this
// announcement are skipped, so re-running after a partial run (timeout,
// QUEUE_FULL) only reaches the ones still missing.

// Parallel sends. iTextMo allows 20 API calls/sec; 6 in flight at ~300ms each
// stays comfortably under that while finishing ~1000 messages inside the
// Edge Function wall-clock budget.
const CONCURRENCY = 6
// Stop starting new sends after this long so the function returns a real
// summary instead of being killed mid-loop. The next run resumes.
const TIME_BUDGET_MS = 110_000
const MAX_RECIPIENTS_PER_RUN = 1000

interface Body {
  announcement_id?: string
}

interface Recipient {
  patientId: string
  phone: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

// "MHO Malilipot: <title> — <body>", trimmed to the SMS cap on a word boundary.
export function composeAnnouncementSms(title: string, body: string): string {
  const flatBody = body.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
  const full = `${SMS_SENDER_PREFIX}: ${title.trim()} — ${flatBody}`
  if (full.length <= MAX_SMS_LENGTH) return full
  const cut = full.slice(0, MAX_SMS_LENGTH - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${cut.slice(0, lastSpace > MAX_SMS_LENGTH - 60 ? lastSpace : cut.length).trimEnd()}…`
}

async function requireAdmin(req: Request): Promise<{ adminId: string; service: SupabaseClient }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceKey) {
    throw new HttpError(500, 'Server is not configured correctly.')
  }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
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
  if (profile?.role !== 'admin') throw new HttpError(403, 'Administrator access required.')

  return { adminId: userData.user.id, service }
}

async function loadRecipients(service: SupabaseClient, announcementId: string): Promise<Recipient[]> {
  const { data: patients, error } = await service
    .from('patients')
    .select('id, profiles!inner ( phone, role )')
    .eq('profiles.role', 'patient')
    .not('profiles.phone', 'is', null)

  if (error) {
    console.error('send-announcement-sms recipient lookup failed:', error.message)
    throw new HttpError(500, 'Could not load the recipient list.')
  }

  const { data: alreadySent, error: sentErr } = await service
    .from('notification_logs')
    .select('patient_id')
    .eq('announcement_id', announcementId)
    .in('status', ['sent', 'delivered'])
    .not('patient_id', 'is', null)

  if (sentErr) {
    console.error('send-announcement-sms sent lookup failed:', sentErr.message)
    throw new HttpError(500, 'Could not load previous delivery records.')
  }
  const done = new Set((alreadySent ?? []).map((r) => r.patient_id as string))

  const seen = new Set<string>()
  const recipients: Recipient[] = []
  for (const row of (patients ?? []) as unknown as {
    id: string
    profiles: { phone: string | null } | null
  }[]) {
    const phone = row.profiles?.phone ?? ''
    if (!isCanonicalPhilippineMobile(phone)) continue
    if (done.has(row.id)) continue
    // One text per household number even if two patient accounts share it.
    if (seen.has(phone)) continue
    seen.add(phone)
    recipients.push({ patientId: row.id, phone })
  }
  return recipients
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  const startedAt = Date.now()

  try {
    const { adminId, service } = await requireAdmin(req)
    const body = (await req.json().catch(() => ({}))) as Body
    const announcementId = (body.announcement_id ?? '').trim()
    if (!isUuid(announcementId)) return json({ error: 'Valid announcement id is required.' }, 400)

    const { data: announcement, error: annErr } = await service
      .from('announcements')
      .select('id, title, body, published')
      .eq('id', announcementId)
      .maybeSingle()
    if (annErr) {
      console.error('send-announcement-sms announcement lookup failed:', annErr.message)
      return json({ error: 'Could not load the announcement.' }, 500)
    }
    if (!announcement) return json({ error: 'Announcement not found.' }, 404)
    if (!announcement.published) {
      return json({ error: 'Publish the announcement before sending it by SMS.' }, 400)
    }

    const message = composeAnnouncementSms(announcement.title, announcement.body)
    const all = await loadRecipients(service, announcementId)
    const queue = all.slice(0, MAX_RECIPIENTS_PER_RUN)

    let sent = 0
    let failed = 0
    let skipped = all.length - queue.length
    let cursor = 0

    const worker = async () => {
      while (cursor < queue.length) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
          skipped += queue.length - cursor
          cursor = queue.length
          return
        }
        const recipient = queue[cursor++]
        try {
          await sendSms(service, {
            event: 'announcement',
            recipient: recipient.phone,
            message,
            patientId: recipient.patientId,
            announcementId,
          })
          sent += 1
        } catch (err) {
          failed += 1
          // Credentials / suspended device: every further send will fail the
          // same way — stop early instead of burning the whole list.
          if (err instanceof HttpError && err.status === 500) {
            skipped += queue.length - cursor
            cursor = queue.length
            return
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))

    if (sent > 0) {
      const { count } = await service
        .from('notification_logs')
        .select('id', { count: 'exact', head: true })
        .eq('announcement_id', announcementId)
        .in('status', ['sent', 'delivered'])
      await service
        .from('announcements')
        .update({ sms_sent_at: new Date().toISOString(), sms_recipient_count: count ?? sent })
        .eq('id', announcementId)
    }

    await service.from('audit_log').insert({
      actor_id: adminId,
      action: 'announcement_sms_broadcast',
      target_table: 'announcements',
      target_id: announcementId,
    })

    return json({
      success: true,
      total: all.length,
      sent,
      failed,
      skipped,
      message,
    })
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('send-announcement-sms unexpected error:', err)
    return json({ error: 'Unexpected server error.' }, 500)
  }
})
