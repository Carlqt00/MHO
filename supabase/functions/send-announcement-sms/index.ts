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
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import {
  HttpError,
  MAX_SMS_LENGTH,
  SMS_SENDER_PREFIX,
  isCanonicalPhilippineMobile,
  sendSms,
} from '../_shared/sms.ts'

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
