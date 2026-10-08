import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import {
  HttpError,
  formatAppointmentTime,
  normalizePhilippineMobile,
  sendSms,
} from '../_shared/sms.ts'

type Role = 'patient' | 'doctor' | 'nurse' | 'staff' | 'admin'
type Action = 'create' | 'resend' | 'lookup' | 'respond'

interface CreateAssignment {
  appointment_id: string
  proposed_slot_id: string
}

interface Body {
  action?: Action
  reason?: string
  expires_hours?: number
  proposals?: CreateAssignment[]
  proposal_id?: string
  token?: string
  response?: 'accepted' | 'declined'
}

interface ProposalSmsDetails {
  proposal_id: string
  appointment_id: string
  patient_id: string
  patient_phone: string | null
  patient_name: string
  service_name: string
  provider_name: string
  original_appointment_at: string
  proposed_appointment_at: string
  reason: string
  token_expires_at: string
}

const DEFAULT_ORIGIN = 'https://mho-daraga.vercel.app'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value)
}

function baseUrl(): string {
  return (
    Deno.env.get('PUBLIC_SITE_URL')?.trim() ||
    Deno.env.get('APP_BASE_URL')?.trim() ||
    Deno.env.get('SITE_URL')?.trim() ||
    DEFAULT_ORIGIN
  ).replace(/\/+$/, '')
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('')
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function responseUrl(token: string): string {
  return `${baseUrl()}/reschedule-response/${encodeURIComponent(token)}`
}

function proposalMessage(row: ProposalSmsDetails, token: string): string {
  return `MHO Daraga: Due to an unexpected provider emergency, we need to move your ${row.service_name} appointment. Proposed new schedule: ${formatAppointmentTime(row.proposed_appointment_at)}. Please confirm or decline here: ${responseUrl(token)}`
}

function acceptedMessage(serviceName: string, proposedAt: string): string {
  return `MHO Daraga: Your ${serviceName} appointment has been rescheduled to ${formatAppointmentTime(proposedAt)}. Thank you for confirming.`
}

function declinedMessage(): string {
  return 'MHO Daraga: You declined the proposed reschedule. The affected appointment has been cancelled. You may contact MHO Daraga or create a new appointment if needed.'
}

async function authenticatedContext(req: Request): Promise<{
  callerId: string
  role: Role
  service: SupabaseClient
}> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !anonKey || !serviceKey) {
    throw new HttpError(500, 'Server is not configured correctly.')
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new HttpError(401, 'Missing authorization token.')

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userErr } = await authClient.auth.getUser()
  if (userErr || !userData?.user) throw new HttpError(401, 'Invalid or expired session.')

  const service = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  const { data: profile, error: profileErr } = await service
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle()

  if (profileErr) throw new HttpError(500, 'Could not verify your permissions.')
  if (!profile) throw new HttpError(403, 'Profile not found.')

  return { callerId: userData.user.id, role: profile.role as Role, service }
}

function serviceContext(): SupabaseClient {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) throw new HttpError(500, 'Server is not configured correctly.')
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function sendProposalSms(
  service: SupabaseClient,
  row: ProposalSmsDetails,
  token: string,
  event: string
) {
  const phone = normalizePhilippineMobile(row.patient_phone ?? '') ?? row.patient_phone ?? ''
  const result = await sendSms(service, {
    event,
    recipient: phone,
    message: proposalMessage(row, token),
    patientId: row.patient_id,
    appointmentId: row.appointment_id,
  })
  return {
    proposal_id: row.proposal_id,
    appointment_id: row.appointment_id,
    patient_name: row.patient_name,
    proposed_appointment_at: row.proposed_appointment_at,
    notification_log_id: result.logId,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  try {
    const body = (await req.json().catch(() => ({}))) as Body
    const action = body.action

    if (action === 'lookup') {
      const token = (body.token ?? '').trim()
      if (!token) return json({ error: 'Response token is required.' }, 400)
      const service = serviceContext()
      const tokenHash = await sha256Hex(token)
      const { data, error } = await service.rpc('get_reschedule_proposal_by_token', {
        p_token_hash: tokenHash,
      })
      if (error) throw new HttpError(500, 'Could not load this reschedule request.')
      const row = Array.isArray(data) ? data[0] : null
      if (!row) return json({ error: 'Reschedule request not found.' }, 404)
      return json({ proposal: row })
    }

    if (action === 'respond') {
      const token = (body.token ?? '').trim()
      const response = body.response
      if (!token) return json({ error: 'Response token is required.' }, 400)
      if (response !== 'accepted' && response !== 'declined') {
        return json({ error: 'Choose accepted or declined.' }, 400)
      }
      const service = serviceContext()
      const tokenHash = await sha256Hex(token)
      const { data, error } = await service.rpc('respond_reschedule_proposal', {
        p_token_hash: tokenHash,
        p_response: response,
      })
      if (error) {
        const raw = error.message ?? ''
        if (raw.includes('ERR_ALREADY_ANSWERED')) return json({ error: 'already_answered' }, 409)
        if (raw.includes('ERR_EXPIRED')) return json({ error: 'expired' }, 410)
        if (raw.includes('ERR_NOT_FOUND')) return json({ error: 'not_found' }, 404)
        throw new HttpError(500, 'Could not record your response.')
      }

      const result = data as {
        appointment_id: string
        patient_id: string
        patient_phone: string | null
        service_name: string
        proposed_appointment_at: string
        status: 'accepted' | 'declined'
      }
      try {
        const phone = normalizePhilippineMobile(result.patient_phone ?? '') ?? result.patient_phone ?? ''
        await sendSms(service, {
          event:
            result.status === 'accepted'
              ? 'emergency_reschedule_accepted'
              : 'emergency_reschedule_declined',
          recipient: phone,
          message:
            result.status === 'accepted'
              ? acceptedMessage(result.service_name, result.proposed_appointment_at)
              : declinedMessage(),
          patientId: result.patient_id,
          appointmentId: result.appointment_id,
        })
      } catch (err) {
        console.error('reschedule response SMS failed:', err)
      }
      return json({ result })
    }

    const { role, service } = await authenticatedContext(req)
    if (role !== 'admin') return json({ error: 'Administrator access required.' }, 403)
    const smsService = serviceContext()

    const expiresHours = Math.min(Math.max(Number(body.expires_hours ?? 24), 1), 168)
    const expiresAt = new Date(Date.now() + expiresHours * 60 * 60 * 1000).toISOString()

    if (action === 'create') {
      const reason = (body.reason ?? '').trim()
      const proposals = body.proposals ?? []
      if (!reason) return json({ error: 'Reason is required.' }, 400)
      if (proposals.length === 0) return json({ error: 'At least one proposal is required.' }, 400)

      const sent = []
      const failed = []
      for (const item of proposals) {
        if (!isUuid(item.appointment_id) || !isUuid(item.proposed_slot_id)) {
          failed.push({ appointment_id: item.appointment_id, error: 'Invalid appointment or slot id.' })
          continue
        }
        const token = randomToken()
        const tokenHash = await sha256Hex(token)
        const { data, error } = await service.rpc('admin_create_reschedule_proposal', {
          p_appointment_id: item.appointment_id,
          p_proposed_slot_id: item.proposed_slot_id,
          p_reason: reason,
          p_token_hash: tokenHash,
          p_token_expires_at: expiresAt,
        })
        if (error) {
          console.error('reschedule-proposal create RPC failed:', {
            appointment_id: item.appointment_id,
            message: error.message,
          })
          failed.push({ appointment_id: item.appointment_id, error: error.message })
          continue
        }
        const row = (Array.isArray(data) ? data[0] : data) as ProposalSmsDetails
        try {
          sent.push(await sendProposalSms(smsService, row, token, 'emergency_reschedule_proposed'))
        } catch (err) {
          console.error('reschedule-proposal SMS send failed:', {
            appointment_id: item.appointment_id,
            proposal_id: row.proposal_id,
            message: err instanceof Error ? err.message : 'SMS could not be sent.',
          })
          failed.push({
            appointment_id: item.appointment_id,
            proposal_id: row.proposal_id,
            error: err instanceof Error ? err.message : 'SMS could not be sent.',
          })
        }
      }
      return json({ success: failed.length === 0, sent, failed })
    }

    if (action === 'resend') {
      const proposalId = (body.proposal_id ?? '').trim()
      if (!isUuid(proposalId)) return json({ error: 'Valid proposal id is required.' }, 400)
      const token = randomToken()
      const tokenHash = await sha256Hex(token)
      const { data, error } = await service.rpc('admin_rotate_reschedule_proposal_token', {
        p_proposal_id: proposalId,
        p_token_hash: tokenHash,
        p_token_expires_at: expiresAt,
      })
      if (error) throw new HttpError(400, error.message)
      const row = (Array.isArray(data) ? data[0] : data) as ProposalSmsDetails
      const sent = await sendProposalSms(smsService, row, token, 'emergency_reschedule_proposal_resent')
      return json({ success: true, sent })
    }

    return json({ error: 'Unsupported action.' }, 400)
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('reschedule-proposal unexpected error:', err)
    return json({ error: 'Unexpected server error.' }, 500)
  }
})
