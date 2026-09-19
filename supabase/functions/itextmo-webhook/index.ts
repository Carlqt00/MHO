// iTextMo delivery webhook (https://itextmo.netlify.app/documentation → Webhooks).
//
// iTextMo calls this with no Supabase JWT, so deploy it with
//   supabase functions deploy itextmo-webhook --no-verify-jwt
// and rely on the HMAC signature instead:
//   X-iTextMo-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">
// signed with the secret that PUT /v1/webhook (or the app's "Save & verify")
// returned. Put that secret in ITEXTMO_WEBHOOK_SECRET.
//
// Events: webhook.verify (echo the challenge), message.sent / message.delivered /
// message.failed (update the matching notification_logs row), message.inbound
// (logged only — STOP/START is enforced by the gateway itself).
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SIGNATURE_TOLERANCE_SECONDS = 300

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-itextmo-signature',
}

interface WebhookPayload {
  event?: string
  type?: string
  event_type?: string
  challenge?: string
  data?: Record<string, unknown> & { challenge?: string }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function parseSignature(header: string | null): { t: string; v1: string } | null {
  if (!header) return null
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const idx = p.indexOf('=')
      return [p.slice(0, idx).trim(), p.slice(idx + 1).trim()]
    })
  )
  return parts.t && parts.v1 ? { t: parts.t, v1: parts.v1 } : null
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Verify against the RAW body bytes, before any JSON parse.
async function verifySignature(req: Request, rawBody: string, secret: string): Promise<boolean> {
  const sig = parseSignature(req.headers.get('x-itextmo-signature'))
  if (!sig) return false
  const ts = Number(sig.t)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(Date.now() / 1000 - ts) > SIGNATURE_TOLERANCE_SECONDS) return false
  const expected = await hmacSha256Hex(secret, `${sig.t}.${rawBody}`)
  return timingSafeEqual(expected, sig.v1.toLowerCase())
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405)

  try {
    const rawBody = await req.text()
    let payload: WebhookPayload = {}
    try {
      payload = rawBody ? (JSON.parse(rawBody) as WebhookPayload) : {}
    } catch {
      payload = {}
    }

    const eventType = payload.event ?? payload.type ?? payload.event_type ?? 'unknown'
    const data = payload.data ?? {}

    // Verification handshake: iTextMo POSTs webhook.verify with a random
    // challenge when the URL is saved; echoing it proves the endpoint is ours.
    const challenge = payload.challenge ?? data.challenge
    if (eventType === 'webhook.verify' || challenge) {
      console.log('iTextMo webhook verification challenge received')
      return json({ challenge })
    }

    const secret = Deno.env.get('ITEXTMO_WEBHOOK_SECRET')?.trim()
    if (secret) {
      if (!(await verifySignature(req, rawBody, secret))) {
        console.warn('iTextMo webhook rejected: bad or missing signature')
        return json({ success: false, error: 'Invalid signature' }, 401)
      }
    } else {
      // Unsigned delivery receipts can only flip a log row's status, but set
      // the secret as soon as the webhook is saved so this path goes away.
      console.warn('ITEXTMO_WEBHOOK_SECRET is not set — accepting unsigned webhook')
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceKey) {
      return json({ success: false, error: 'Server is not configured correctly' }, 500)
    }
    const service = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const providerMessageId = str(data.id) ?? str(data.message_id) ?? str(data.messageId)
    const clientRef = str(data.client_ref) ?? str(data.clientRef)
    const failureReason =
      str(data.reason) ?? str(data.error) ?? str(data.failure_reason) ?? str(data.code)

    // Match our log row by the gateway id we stored at send time, falling
    // back to client_ref (which we set to the notification_logs id).
    const match = providerMessageId
      ? { by: 'provider_message_id', value: providerMessageId }
      : clientRef
        ? { by: 'id', value: clientRef }
        : null

    const applyStatus = async (patch: Record<string, unknown>, onlyStatuses?: string[]) => {
      if (!match) {
        console.warn(`iTextMo ${eventType}: no message id in payload, nothing to update`)
        return
      }
      let query = service.from('notification_logs').update(patch).eq(match.by, match.value)
      if (onlyStatuses) query = query.in('status', onlyStatuses)
      const { error } = await query
      if (error) console.error(`iTextMo ${eventType}: log update failed:`, error.message)
    }

    switch (eventType) {
      case 'message.sent':
        // Handset actually transmitted it. Never regress a 'delivered' row.
        await applyStatus({ status: 'sent', sent_at: new Date().toISOString() }, ['pending', 'sent'])
        break

      case 'message.delivered':
        await applyStatus({ status: 'delivered', error_message: null })
        break

      case 'message.failed':
        await applyStatus({
          status: 'failed',
          error_message: failureReason
            ? `Gateway reported failure: ${failureReason}`.slice(0, 200)
            : 'Gateway reported delivery failure.',
        })
        break

      case 'message.inbound':
        // Replies (including STOP/START) are handled by the gateway's own
        // blocklist; we only note that one arrived, never its content.
        console.log('iTextMo inbound SMS received from', str(data.from) ? 'a known number' : 'unknown')
        break

      default:
        console.log('Unknown iTextMo webhook event:', eventType)
    }

    return json({ success: true, received: true })
  } catch (error) {
    console.error('iTextMo webhook error:', error)
    return json({ success: false, error: 'Webhook processing failed' }, 500)
  }
})
