// Public: start a password reset. The caller proves they know the account's
// full name + email + registered phone; if all three match ONE profile, a
// 6-digit code is texted to that phone and a reset request is stored with the
// code's hash. The code itself is NEVER returned to the browser — possession
// of the phone is the second factor. password-reset-complete consumes it.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import {
  HttpError,
  SMS_SENDER_PREFIX,
  maskPhilippineMobile,
  normalizePhilippineMobile,
  sendSms,
} from '../_shared/sms.ts'
import { RESET_CODE_LENGTH, hashResetCode } from '../_shared/reset-code.ts'

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
