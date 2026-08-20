// ============================================================
// admin-update-role — admin-only change of an existing user's role.
//
// Updates BOTH sources of truth:
//   1. auth app_metadata.role  → what future JWTs will carry
//   2. profiles.role           → what RLS reads right now via my_role()
// The on_auth_user_created trigger fires only on INSERT, so step 2 is
// not automatic — we do it explicitly with the service role (auth.uid()
// is null under the service role, so prevent_role_escalation allows it).
//
// Scope note: promoting to doctor/nurse ensures a providers row exists.
// Demoting a provider to a non-provider role does NOT delete the existing
// providers row (it may be referenced by historical appointments) — that
// cleanup is deliberately left for a later phase.
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

interface UpdateBody {
  userId?: string
  role?: Role
  providerType?: ProviderType
  specialization?: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  try {
    const { callerId, service } = await requireAdmin(req)

    const body = (await req.json().catch(() => ({}))) as UpdateBody
    const userId = (body.userId ?? '').trim()
    const role = body.role

    if (!userId) return json({ error: 'Target user id is required.' }, 400)
    if (!role || !ROLES.includes(role)) return json({ error: 'A valid role is required.' }, 400)

    // ---- self-protection ----
    // An admin cannot change their OWN role: prevents accidental self-
    // demotion and last-admin lockout. Enforced here (server-side) so the
    // UI guard can never be bypassed by crafting a request.
    if (userId === callerId) {
      return json({ error: 'You cannot change your own role.' }, 403)
    }

    const providerType = resolveProviderType(role, body.providerType) // throws HttpError(400)

    // Confirm the target exists.
    const { data: target, error: targetErr } = await service
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle()
    if (targetErr) return json({ error: 'Could not load the target user.' }, 500)
    if (!target) return json({ error: 'User not found.' }, 404)

    // ---- 1. update the JWT source of truth ----
    const { error: authErr } = await service.auth.admin.updateUserById(userId, {
      app_metadata: { role },
    })
    if (authErr) return json({ error: 'Could not update the account role.' }, 500)

    // ---- 2. update profiles.role (authoritative for RLS) ----
    const { error: profErr } = await service.from('profiles').update({ role }).eq('id', userId)
    if (profErr) return json({ error: 'Could not update the profile role.' }, 500)

    // ---- 3. ensure a providers row when promoting to doctor/nurse ----
    if (providerType) {
      const { data: existing } = await service
        .from('providers')
        .select('id')
        .eq('profile_id', userId)
        .maybeSingle()
      if (!existing) {
        const { error: provErr } = await service.from('providers').insert({
          profile_id: userId,
          provider_type: providerType,
          specialization: (body.specialization ?? '').trim() || null,
        })
        if (provErr) return json({ error: 'Role updated, but the provider record failed.' }, 500)
      }
    }

    await service.from('audit_log').insert({
      actor_id: callerId,
      action: 'admin_update_role',
      target_table: 'profiles',
      target_id: userId,
    })

    return json({ userId, role })
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('admin-update-role unexpected error:', err) // server logs only
    return json({ error: 'Unexpected server error.' }, 500)
  }
})
