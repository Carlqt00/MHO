// iTextMo delivery webhook (https://itextmo.netlify.app/documentation -> Webhooks).
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
// (save the reply in sms_inbox; STOP/START is enforced by the gateway itself).
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const SIGNATURE_TOLERANCE_SECONDS = 300

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-itextmo-signature',
}

type WebhookPayload = Record<string, unknown> & {
  event?: unknown
  type?: unknown
  event_type?: unknown
  name?: unknown
  challenge?: unknown
  at?: unknown
  data?: Record<string, unknown> & { challenge?: unknown }
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

async function verifySignature(req: Request, rawBody: string, secret: string): Promise<boolean> {
  const sig = parseSignature(req.headers.get('x-itextmo-signature'))
  if (!sig) return false
  const ts = Number(sig.t)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(Date.now() / 1000 - ts) > SIGNATURE_TOLERANCE_SECONDS) return false
  const expected = await hmacSha256Hex(secret, `${sig.t}.${rawBody}`)
  return timingSafeEqual(expected, sig.v1.toLowerCase())
}

function parsePayload(req: Request, rawBody: string): WebhookPayload {
  if (req.method === 'GET') {
    return Object.fromEntries(new URL(req.url).searchParams.entries())
  }
  if (!rawBody) return {}
  try {
    return JSON.parse(rawBody) as WebhookPayload
  } catch {
    return Object.fromEntries(new URLSearchParams(rawBody))
  }
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim()
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function serviceClient(): SupabaseClient {
  return createClient(requiredEnv('SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function stringField(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function str(value: unknown): string | null {
  const text = stringField(value)
  return text || null
}

function receivedAt(payload: WebhookPayload): string {
  const raw = stringField(payload.at, payload.data?.at, payload.data?.received_at, payload.data?.timestamp)
  if (!raw) return new Date().toISOString()
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function inboundFields(payload: WebhookPayload): {
  providerMessageId: string | null
  sender: string
  message: string
  receivedAt: string
  isTest: boolean
} {
  const data = payload.data ?? {}
  return {
    providerMessageId: stringField(data.id, data.message_id, data.messageId) || null,
    sender: stringField(data.from, data.sender, data.phone, data.msisdn, data.mobile, payload.from),
    message: stringField(data.body, data.message, data.text, data.content, payload.body, payload.message),
    receivedAt: receivedAt(payload),
    isTest: data.test === true || payload.test === true,
  }
}

async function saveInboundSms(service: SupabaseClient, payload: WebhookPayload): Promise<void> {
  const inbound = inboundFields(payload)

  if (inbound.isTest) {
    console.log('Synthetic inbound SMS test event ignored')
    return
  }

  if (!inbound.sender || !inbound.message) {
    console.warn('Inbound SMS missing sender or message body; not saved')
    return
  }

  const { error } = await service.from('sms_inbox').insert({
    provider_message_id: inbound.providerMessageId,
    sender: inbound.sender,
    message: inbound.message,
    received_at: inbound.receivedAt,
    raw_payload: payload,
  })

  if (error?.code === '23505') {
    console.log('Duplicate inbound SMS webhook ignored')
    return
  }

  if (error) {
    console.error('sms_inbox insert failed:', error.message)
    throw error
  }

  console.log('Inbound SMS saved', {
    providerMessageId: inbound.providerMessageId,
    sender: inbound.sender,
    receivedAt: inbound.receivedAt,
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ success: false, error: 'Method not allowed' }, 405)
  }

  try {
    const rawBody = req.method === 'POST' ? await req.text() : ''
    const payload = parsePayload(req, rawBody)
    const data = payload.data ?? {}
    const eventType = stringField(payload.event, payload.type, payload.event_type, payload.name) || 'unknown'

    console.log('iTextMo webhook received')

    const challenge =
      payload.challenge ??
      data.challenge ??
      new URL(req.url).searchParams.get('challenge')

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
      console.warn('ITEXTMO_WEBHOOK_SECRET is not set - accepting unsigned webhook')
    }

    const service = serviceClient()
    const providerMessageId = str(data.id) ?? str(data.message_id) ?? str(data.messageId)
    const clientRef = str(data.client_ref) ?? str(data.clientRef)
    const failureReason =
      str(data.reason) ?? str(data.error) ?? str(data.failure_reason) ?? str(data.code)

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

    console.log(`iTextMo event: ${eventType}`)

    switch (eventType) {
      case 'message.sent':
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
        console.log('Inbound SMS received')
        await saveInboundSms(service, payload)
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
