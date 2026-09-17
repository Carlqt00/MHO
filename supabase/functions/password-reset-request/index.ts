import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

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

function normalizePhone(value: string): string {
  let digits = value.replace(/\D/g, '')
  if (digits.startsWith('63')) digits = digits.slice(2)
  else if (digits.startsWith('0')) digits = digits.slice(1)
  if (!/^9\d{9}$/.test(digits)) return ''
  return `+63${digits}`
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
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
    const phone = normalizePhone(body.phone ?? '')

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
      phoneMatch: normalizePhone(row.phone ?? '') === phone,
    }))

    const matched = comparisons.find(
      (comparison) => comparison.emailMatch && comparison.nameMatch && comparison.phoneMatch
    )
    const profile = matched?.row

    if (!profile) {
      const hasEmailCandidate = (matches ?? []).length > 0
      console.info('password-reset-request verification mismatch:', {
        email_match: comparisons.some((comparison) => comparison.emailMatch) || hasEmailCandidate,
        name_match: comparisons.some((comparison) => comparison.nameMatch),
        phone_match: comparisons.some((comparison) => comparison.phoneMatch),
        phone_received_normalized: phone ? '+639XXXXXXXXX' : '',
        candidate_count: matches?.length ?? 0,
      })
      return json({ verified: false })
    }

    const resetToken = randomToken()
    const tokenHash = await sha256Hex(resetToken)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString()

    await service
      .from('password_reset_requests')
      .update({ status: 'expired' })
      .eq('profile_id', profile.id)
      .eq('status', 'approved')
      .lt('token_expires_at', now.toISOString())

    const { data: existingRequest, error: existingErr } = await service
      .from('password_reset_requests')
      .select('id')
      .eq('profile_id', profile.id)
      .in('status', ['pending', 'approved'])
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingErr) {
      console.error('password-reset-request active lookup failed:', existingErr.message)
      return json({ error: 'Could not submit the request.' }, 500)
    }

    console.info('password-reset-request verification approved:', {
      candidate_count: matches?.length ?? 0,
      email_match: true,
      name_match: true,
      phone_match: true,
      phone_received_normalized: '+639XXXXXXXXX',
      existing_active_request: Boolean(existingRequest),
    })

    let requestId = existingRequest?.id
    if (requestId) {
      const { error: updateErr } = await service
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
        })
        .eq('id', requestId)

      if (updateErr) {
        console.error('password-reset-request approval update failed:', updateErr.message)
        return json({ error: 'Could not submit the request.' }, 500)
      }
    } else {
      const { data: insertedRequest, error: insertErr } = await service
        .from('password_reset_requests')
        .insert({
          profile_id: profile.id,
          status: 'approved',
          approved_at: now.toISOString(),
          requested_at: now.toISOString(),
          processed_at: null,
          processed_by: null,
          completed_at: null,
          token_hash: tokenHash,
          token_expires_at: expiresAt,
          token_used_at: null,
        })
        .select('id')
        .single()

      if (insertErr || !insertedRequest) {
        console.error('password-reset-request approval insert failed:', insertErr?.message)
        return json({ error: 'Could not submit the request.' }, 500)
      }
      requestId = insertedRequest.id
    }

    await service.from('audit_log').insert({
      actor_id: profile.id,
      action: 'password_reset_approved',
      target_table: 'password_reset_requests',
      target_id: requestId,
    })

    return json({ verified: true, resetToken, expiresAt })
  } catch (err) {
    console.error('password-reset-request unexpected error:', err)
    return json({ error: 'Unexpected server error.' }, 500)
  }
})
