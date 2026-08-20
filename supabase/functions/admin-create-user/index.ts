// ============================================================
// admin-create-user — admin-only creation of staff/provider/admin
// (and, if ever needed, patient) accounts.
//
// Why an Edge Function: app_metadata.role can only be set with the
// service-role key, which must never reach the browser. The service
// role also bypasses RLS to insert the providers roster row.
//
// The handle_new_user trigger reads app_metadata.role to stamp
// profiles.role and (for patients) create the patients row.
// ============================================================

import {
  requireAdmin,
  resolveProviderType,
  HttpError,
  json,
  ROLES,
  type Role,
  type ProviderType,
} from '../_shared/admin.ts'
import { corsHeaders } from '../_shared/cors.ts'

interface CreateBody {
  email?: string
  fullName?: string
  role?: Role
  phone?: string
  password?: string
  providerType?: ProviderType
  specialization?: string
}

// A reasonable temporary password when the admin doesn't supply one.
// Returned once to the admin so they can hand it to the new user.
function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const base = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '')
  return `${base.slice(0, 14)}A9!` // guarantees length + mixed classes
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  try {
    const { callerId, service } = await requireAdmin(req)

    const body = (await req.json().catch(() => ({}))) as CreateBody
    const email = (body.email ?? '').trim().toLowerCase()
    const fullName = (body.fullName ?? '').trim()
    const role = body.role
    const phone = (body.phone ?? '').trim()

    // ---- validate ----
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: 'A valid email is required.' }, 400)
    }
    if (!fullName) return json({ error: 'Full name is required.' }, 400)
    if (!role || !ROLES.includes(role)) return json({ error: 'A valid role is required.' }, 400)

    const providerType = resolveProviderType(role, body.providerType) // throws HttpError(400)

    const supplied = typeof body.password === 'string' && body.password.length >= 8
    const password = supplied ? (body.password as string) : randomPassword()

    // ---- create the auth user with server-only app_metadata.role ----
    const { data: created, error: createErr } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // project runs with email confirmation OFF
      app_metadata: { role },
      user_metadata: { full_name: fullName, phone },
    })

    if (createErr || !created?.user) {
      const duplicate = /already.*registered|exists|duplicate/i.test(createErr?.message ?? '')
      return json(
        { error: duplicate ? 'A user with this email already exists.' : 'Could not create the user.' },
        400
      )
    }

    const userId = created.user.id

    // ---- provider roster row for doctor/nurse ----
    if (providerType) {
      const { error: provErr } = await service.from('providers').insert({
        profile_id: userId,
        provider_type: providerType,
        specialization: (body.specialization ?? '').trim() || null,
      })
      if (provErr) {
        // Roll back so we never strand a doctor/nurse with no provider row.
        await service.auth.admin.deleteUser(userId)
        return json({ error: 'Could not create the provider record.' }, 500)
      }
    }

    await service.from('audit_log').insert({
      actor_id: callerId,
      action: 'admin_create_user',
      target_table: 'profiles',
      target_id: userId,
    })

    return json(
      {
        userId,
        email,
        role,
        // Only present when we generated it — show once so the admin can
        // pass it along. Not stored anywhere.
        generatedPassword: supplied ? undefined : password,
      },
      201
    )
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('admin-create-user unexpected error:', err) // server logs only
    return json({ error: 'Unexpected server error.' }, 500)
  }
})
