// ============================================================
// PASTE-READY BUNDLE for the Supabase Dashboard editor.
// Generated from supabase/functions/password-reset-complete/index.ts with the _shared modules
// (cors.ts, reset-code.ts) inlined. Do not edit here — edit the
// source files and re-run scratchpad bundle.js. CLI deploys use the originals.
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2'

// ---- inlined from _shared/cors.ts ----
// CORS headers for browser calls. Auth is carried in the Authorization
// bearer header (not cookies), so a wildcard origin is safe here — no
// credentialed requests. Tighten to your app origin if you prefer.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

// ---- password-reset-complete/index.ts ----
// Public: finish a password reset with the 6-digit code that
// password-reset-request texted to the account's phone.
//
// Body: { requestId, code, newPassword }. Wrong codes are counted per request
// and the request is voided after RESET_CODE_MAX_ATTEMPTS — a 6-digit space
// must not be guessable by hammering this endpoint.

interface Body {
  requestId?: string
  code?: string
  newPassword?: string
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

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
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
    const requestId = (body.requestId ?? '').trim()
    const code = (body.code ?? '').replace(/\s+/g, '')
    const newPassword = body.newPassword ?? ''

    if (!isUuid(requestId) || !isResetCode(code) || newPassword.length < 8) {
      return json({ error: 'Valid reset code and password are required.' }, 400)
    }

    const service = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const now = new Date().toISOString()

    const { data: resetRequest, error: lookupErr } = await service
      .from('password_reset_requests')
      .select('id, profile_id, status, token_hash, token_expires_at, token_used_at, code_attempts')
      .eq('id', requestId)
      .maybeSingle()

    if (lookupErr) {
      console.error('password-reset-complete lookup failed:', lookupErr.message)
      return json({ error: 'Could not complete the password reset.' }, 500)
    }

    const expiresAt = resetRequest?.token_expires_at
      ? Date.parse(resetRequest.token_expires_at)
      : Number.NaN

    const usable =
      resetRequest &&
      resetRequest.status === 'approved' &&
      !resetRequest.token_used_at &&
      resetRequest.token_hash &&
      !Number.isNaN(expiresAt) &&
      expiresAt > Date.now()

    if (!usable) {
      if (resetRequest && resetRequest.status === 'approved') {
        await service
          .from('password_reset_requests')
          .update({ status: 'expired' })
          .eq('id', resetRequest.id)
      }
      return json({ error: 'Reset code is expired or invalid. Please request a new one.' }, 400)
    }

    const expectedHash = await hashResetCode(resetRequest.id, code)
    if (!timingSafeEqualHex(expectedHash, resetRequest.token_hash as string)) {
      const attempts = (resetRequest.code_attempts ?? 0) + 1
      const exhausted = attempts >= RESET_CODE_MAX_ATTEMPTS
      await service
        .from('password_reset_requests')
        .update(exhausted ? { code_attempts: attempts, status: 'expired' } : { code_attempts: attempts })
        .eq('id', resetRequest.id)

      if (exhausted) {
        await service.from('audit_log').insert({
          actor_id: resetRequest.profile_id,
          action: 'password_reset_code_locked',
          target_table: 'password_reset_requests',
          target_id: resetRequest.id,
        })
        return json(
          { error: 'Too many incorrect codes. Please request a new reset code.' },
          400
        )
      }
      return json(
        {
          error: 'Incorrect code. Please check the SMS and try again.',
          attemptsLeft: RESET_CODE_MAX_ATTEMPTS - attempts,
        },
        400
      )
    }

    const { error: authErr } = await service.auth.admin.updateUserById(resetRequest.profile_id, {
      password: newPassword,
    })
    if (authErr) {
      console.error('password-reset-complete auth update failed:', authErr.message)
      await service
        .from('password_reset_requests')
        .update({ status: 'failed' })
        .eq('id', resetRequest.id)
      return json({ error: 'Could not update the password.' }, 500)
    }

    const { error: profileErr } = await service
      .from('profiles')
      .update({ password_change_required: false })
      .eq('id', resetRequest.profile_id)
    if (profileErr) {
      console.error('password-reset-complete profile update failed:', profileErr.message)
      return json({ error: 'Password updated, but profile follow-up failed.' }, 500)
    }

    const { error: completeErr } = await service
      .from('password_reset_requests')
      .update({
        status: 'completed',
        completed_at: now,
        processed_at: now,
        token_used_at: now,
      })
      .eq('id', resetRequest.id)
      .eq('status', 'approved')
      .is('token_used_at', null)

    if (completeErr) {
      console.error('password-reset-complete status update failed:', completeErr.message)
      return json({ error: 'Password updated, but reset status failed.' }, 500)
    }

    await service.from('audit_log').insert({
      actor_id: resetRequest.profile_id,
      action: 'password_reset_completed',
      target_table: 'profiles',
      target_id: resetRequest.profile_id,
    })

    return json({ completed: true })
  } catch (err) {
    console.error('password-reset-complete unexpected error:', err)
    return json({ error: 'Unexpected server error.' }, 500)
  }
})
