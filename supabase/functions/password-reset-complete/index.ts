import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

interface Body {
  resetToken?: string
  newPassword?: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
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
    const resetToken = (body.resetToken ?? '').trim()
    const newPassword = body.newPassword ?? ''

    if (!resetToken || newPassword.length < 8) {
      return json({ error: 'Valid reset authorization and password are required.' }, 400)
    }

    const service = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const tokenHash = await sha256Hex(resetToken)
    const now = new Date().toISOString()

    const { data: resetRequest, error: lookupErr } = await service
      .from('password_reset_requests')
      .select('id, profile_id, status, token_expires_at, token_used_at')
      .eq('token_hash', tokenHash)
      .eq('status', 'approved')
      .is('token_used_at', null)
      .maybeSingle()

    if (lookupErr) {
      console.error('password-reset-complete lookup failed:', lookupErr.message)
      return json({ error: 'Could not complete the password reset.' }, 500)
    }

    const expiresAt = resetRequest?.token_expires_at
      ? Date.parse(resetRequest.token_expires_at)
      : Number.NaN

    if (!resetRequest || Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
      if (resetRequest) {
        await service
          .from('password_reset_requests')
          .update({ status: 'expired' })
          .eq('id', resetRequest.id)
      }
      return json({ error: 'Reset authorization is expired or invalid.' }, 400)
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
