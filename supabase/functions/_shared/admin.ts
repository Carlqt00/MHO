// ============================================================
// _shared/admin.ts — the security gate for every admin Edge Function.
//
// requireAdmin(req) is the ONLY thing that decides whether a caller is
// allowed to perform a privileged action. Both admin functions call it
// before touching the service-role client.
//
// Design rules (see the security reasoning in the PR / docs):
//   1. Identity comes ONLY from the verified JWT — never from the body.
//   2. The JWT is validated against GoTrue (signature, expiry, banned).
//   3. Admin status is read LIVE from profiles.role with the service
//      role — we do not trust the (possibly stale) role claim in the JWT.
//   4. Fail closed: any error throws HttpError and the caller gets a
//      generic message. The service-role key is never returned.
// ============================================================

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from './cors.ts'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export interface AdminContext {
  callerId: string
  service: SupabaseClient
}

export async function requireAdmin(req: Request): Promise<AdminContext> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceKey) {
    // Don't reveal which secret is missing.
    throw new HttpError(500, 'Server is not configured correctly.')
  }

  // 1. Require a bearer token. This is the caller's identity — the request
  //    body is never trusted for who the caller is or what role they hold.
  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new HttpError(401, 'Missing authorization token.')

  // 2. Validate the JWT against GoTrue. A forged, tampered, expired, or
  //    revoked token fails here — getUser verifies signature and status.
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userErr } = await authClient.auth.getUser()
  if (userErr || !userData?.user) throw new HttpError(401, 'Invalid or expired session.')
  const callerId = userData.user.id

  // 3. Authorize against LIVE state. profiles.role is the authoritative,
  //    current role (RLS reads it via my_role()). We deliberately do not
  //    trust userData.user.app_metadata.role: it is baked into the JWT at
  //    issue time and would still say 'admin' for a token minted before the
  //    caller was demoted. Read it fresh with the service role.
  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: profile, error: profileErr } = await service
    .from('profiles')
    .select('role')
    .eq('id', callerId)
    .maybeSingle()
  if (profileErr) throw new HttpError(500, 'Could not verify your permissions.')
  if (!profile || profile.role !== 'admin') {
    throw new HttpError(403, 'Administrator access required.')
  }

  return { callerId, service }
}

// Shared role/provider constants + validation used by both functions.
export type Role = 'patient' | 'doctor' | 'nurse' | 'staff' | 'admin'
export const ROLES: Role[] = ['patient', 'doctor', 'nurse', 'staff', 'admin']

export type ProviderType = 'doctor' | 'nurse' | 'dentist'
export const PROVIDER_TYPES: ProviderType[] = ['doctor', 'nurse', 'dentist']

// Resolves + validates the provider_type for a provider role. Throws
// HttpError(400) on an inconsistent combination (e.g. a nurse marked dentist).
export function resolveProviderType(role: Role, requested?: ProviderType): ProviderType | null {
  if (role !== 'doctor' && role !== 'nurse') return null
  const providerType = requested ?? (role as ProviderType)
  if (!PROVIDER_TYPES.includes(providerType)) {
    throw new HttpError(400, 'Invalid provider type.')
  }
  if (role === 'nurse' && providerType !== 'nurse') {
    throw new HttpError(400, 'Nurse accounts must use the nurse provider type.')
  }
  if (role === 'doctor' && providerType !== 'doctor' && providerType !== 'dentist') {
    throw new HttpError(400, 'Doctor accounts must be doctor or dentist.')
  }
  return providerType
}
