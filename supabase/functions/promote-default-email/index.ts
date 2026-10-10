import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVISIBLE_EMAIL_WHITESPACE_RE = /[\u200B-\u200D\uFEFF]/g

function normalizeEmail(value: string): string {
  return value.replace(INVISIBLE_EMAIL_WHITESPACE_RE, '').trim().toLowerCase()
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new HttpError(500, 'Server is not configured correctly.')
  return value
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  try {
    const supabaseUrl = requiredEnv('SUPABASE_URL')
    const anonKey = requiredEnv('SUPABASE_ANON_KEY')
    const serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY')

    const authHeader = req.headers.get('Authorization') ?? ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (!token) throw new HttpError(401, 'Missing authorization token.')

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user) throw new HttpError(401, 'Invalid or expired session.')
    const userId = userData.user.id

    const body = (await req.json().catch(() => ({}))) as { selected_email?: string }
    const selectedEmail = normalizeEmail(body.selected_email ?? '')
    if (!selectedEmail || !EMAIL_RE.test(selectedEmail)) {
      throw new HttpError(400, 'The selected email address is not valid. Please remove it and add the email again.')
    }

    const service = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: profile, error: profileErr } = await service
      .from('profiles')
      .select('email')
      .eq('id', userId)
      .maybeSingle()
    if (profileErr) throw new HttpError(500, 'Could not load your profile.')
    if (!profile) throw new HttpError(404, 'Profile not found.')

    const currentPrimary = normalizeEmail(profile.email ?? '')
    if (selectedEmail === currentPrimary) {
      throw new HttpError(400, 'This email is already your default email.')
    }

    const { data: contact, error: contactErr } = await service
      .from('profile_contacts')
      .select('id')
      .eq('profile_id', userId)
      .eq('contact_type', 'email')
      .eq('contact_value', selectedEmail)
      .maybeSingle()
    if (contactErr) throw new HttpError(500, 'Could not verify the selected email.')
    if (!contact) {
      throw new HttpError(403, 'That additional email is no longer available. Please refresh and try again.')
    }

    let page = 1
    const perPage = 1000
    while (true) {
      const { data: existingUsers, error: existingErr } = await service.auth.admin.listUsers({
        page,
        perPage,
      })
      if (existingErr) throw new HttpError(500, 'Could not verify email availability.')
      const usedByAnotherUser = existingUsers.users.some(
        (user) => user.id !== userId && normalizeEmail(user.email ?? '') === selectedEmail
      )
      if (usedByAnotherUser) {
        throw new HttpError(409, 'This email is already associated with another account.')
      }
      if (existingUsers.users.length < perPage) break
      page += 1
    }

    // admin.updateUserById applies the Auth email directly and bypasses the
    // normal user email-change confirmation flow. This function is only called
    // after the patient confirms the existing "Set as Default" modal, and it
    // only accepts an email already owned as an additional contact by the same
    // authenticated user.
    const { error: authErr } = await service.auth.admin.updateUserById(userId, {
      email: selectedEmail,
    })
    if (authErr) {
      const code = authErr.code ?? ''
      if (code === 'email_exists' || /already.*registered/i.test(authErr.message)) {
        throw new HttpError(409, 'This email is already associated with another account.')
      }
      if (code === 'email_address_invalid') {
        throw new HttpError(400, 'The selected email address is not valid. Please remove it and add the email again.')
      }
      console.error('promote-default-email auth update failed:', {
        code,
        status: authErr.status,
        message: authErr.message,
      })
      throw new HttpError(500, 'Could not update your default email. Please try again or contact MHO.')
    }

    const { error: swapErr } = await userClient.rpc('promote_default_email_contact', {
      p_email: selectedEmail,
    })
    if (swapErr) {
      console.error('promote-default-email profile swap failed:', {
        code: swapErr.code,
        message: swapErr.message,
      })
      throw new HttpError(500, 'Your login email was updated, but your profile contact list could not be refreshed. Please contact MHO.')
    }

    const { data: refreshedProfile, error: refreshErr } = await service
      .from('profiles')
      .select('id, full_name, email, phone')
      .eq('id', userId)
      .maybeSingle()
    if (refreshErr) throw new HttpError(500, 'Default email updated, but the profile could not be refreshed.')

    return json({
      success: true,
      profile: refreshedProfile,
    })
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('promote-default-email unexpected error:', err)
    return json({ error: 'Unexpected server error.' }, 500)
  }
})
