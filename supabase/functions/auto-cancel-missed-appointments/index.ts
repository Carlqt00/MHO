import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import {
  HttpError,
  SMS_SENDER_PREFIX,
  formatAppointmentTime,
  sendSms,
} from '../_shared/sms.ts'

const EVENT = 'appointment_auto_cancelled_missed_checkin'

interface AppointmentDetails {
  id: string
  appointment_at: string | null
  patient_id: string
  patients: {
    profiles: { phone: string | null } | null
  } | null
  services: { name: string } | null
  time_slots: { slot_datetime: string } | null
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function serviceClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    throw new HttpError(500, 'Server is not configured correctly.')
  }
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function authorize(req: Request): void {
  const secret = Deno.env.get('AUTO_CANCEL_CRON_SECRET')?.trim()
  if (!secret) return

  const bearer = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim()
  const headerSecret = req.headers.get('x-cron-secret')?.trim()
  if (bearer === secret || headerSecret === secret) return
  throw new HttpError(401, 'Unauthorized.')
}

function appointmentInstant(appointment: AppointmentDetails): string | null {
  return appointment.appointment_at ?? appointment.time_slots?.slot_datetime ?? null
}

function autoCancelMessage(appointment: AppointmentDetails): string {
  const service = appointment.services?.name ?? 'your appointment'
  const when = appointmentInstant(appointment)
  const whenText = when ? formatAppointmentTime(when) : null
  return whenText
    ? `${SMS_SENDER_PREFIX}: Your ${service} appointment scheduled for ${whenText} was automatically cancelled because you did not check in within 15 minutes of your appointment time.`
    : `${SMS_SENDER_PREFIX}: Your ${service} appointment was automatically cancelled because you did not check in within 15 minutes of your appointment time.`
}

async function fetchAppointment(
  service: SupabaseClient,
  appointmentId: string
): Promise<AppointmentDetails | null> {
  const { data, error } = await service
    .from('appointments')
    .select(
      `
      id, appointment_at, patient_id,
      patients!inner (
        profiles!inner ( phone )
      ),
      services ( name ),
      time_slots ( slot_datetime )
    `
    )
    .eq('id', appointmentId)
    .eq('status', 'cancelled')
    .maybeSingle()

  if (error) {
    console.error('auto-cancel appointment lookup failed:', error.message)
    throw new HttpError(500, 'Could not load an auto-cancelled appointment.')
  }
  return data as unknown as AppointmentDetails | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  try {
    authorize(req)
    const service = serviceClient()
    const body = (await req.json().catch(() => ({}))) as { limit?: number }
    const limit = Math.min(Math.max(Number(body.limit ?? 100) || 100, 1), 500)

    const { data: cancelledRows, error: cancelErr } = await service.rpc(
      'auto_cancel_missed_appointments',
      { p_limit: limit }
    )
    if (cancelErr) {
      console.error('auto-cancel RPC failed:', cancelErr.message)
      throw new HttpError(500, 'Could not auto-cancel missed appointments.')
    }

    const { data: smsRows, error: smsDueErr } = await service.rpc(
      'list_auto_cancel_missed_sms_due',
      { p_limit: limit }
    )
    if (smsDueErr) {
      console.error('auto-cancel SMS due lookup failed:', smsDueErr.message)
      throw new HttpError(500, 'Could not load auto-cancel SMS work.')
    }

    let smsSent = 0
    let smsFailed = 0
    const failures: Array<{ appointment_id: string; error: string }> = []

    for (const row of (smsRows ?? []) as Array<{ appointment_id: string }>) {
      const appointment = await fetchAppointment(service, row.appointment_id)
      if (!appointment) continue

      try {
        await sendSms(service, {
          event: EVENT,
          recipient: appointment.patients?.profiles?.phone ?? '',
          message: autoCancelMessage(appointment),
          patientId: appointment.patient_id,
          appointmentId: appointment.id,
        })
        smsSent += 1
      } catch (err) {
        smsFailed += 1
        const message = err instanceof Error ? err.message : 'SMS notification could not be sent.'
        failures.push({ appointment_id: appointment.id, error: message })
        console.error('auto-cancel SMS failed:', { appointment_id: appointment.id, error: message })
      }
    }

    return json({
      success: true,
      cancelled: (cancelledRows ?? []).length,
      sms_sent: smsSent,
      sms_failed: smsFailed,
      failures,
    })
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('auto-cancel unexpected error:', err)
    return json({ error: 'Unexpected server error.' }, 500)
  }
})
