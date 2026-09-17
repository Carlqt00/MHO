const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })
}

async function readPayload(req: Request): Promise<Record<string, any>> {
  const contentType = req.headers.get('content-type') ?? ''

  if (req.method === 'GET') {
    const url = new URL(req.url)
    return Object.fromEntries(url.searchParams.entries())
  }

  if (contentType.includes('application/json')) {
    try {
      return await req.json()
    } catch {
      return {}
    }
  }

  const raw = await req.text()

  if (!raw) return {}

  try {
    return JSON.parse(raw)
  } catch {
    return Object.fromEntries(new URLSearchParams(raw))
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return json(
      {
        success: false,
        error: 'Method not allowed',
      },
      405,
    )
  }

  try {
    const payload = await readPayload(req)

    console.log('iTextMo webhook received:', JSON.stringify(payload))

    /*
     * iTextMo sends a webhook verification challenge when
     * "Save & verify" is pressed in the Android app.
     *
     * Echo the challenge back.
     */
    const challenge =
      payload?.challenge ??
      payload?.data?.challenge ??
      new URL(req.url).searchParams.get('challenge')

    if (challenge) {
      console.log('iTextMo webhook verification challenge received')

      return json({
        challenge,
      })
    }

    /*
     * Support the event names shown in the iTextMo app:
     *
     * message.sent
     * message.delivered
     * message.failed
     * message.inbound
     */
    const eventType =
      payload?.event ??
      payload?.type ??
      payload?.event_type ??
      payload?.name ??
      'unknown'

    console.log(`iTextMo event: ${eventType}`)

    switch (eventType) {
      case 'message.sent':
        console.log('SMS accepted/sent:', JSON.stringify(payload))
        break

      case 'message.delivered':
        console.log('SMS delivered:', JSON.stringify(payload))
        break

      case 'message.failed':
        console.log('SMS failed:', JSON.stringify(payload))
        break

      case 'message.inbound':
        console.log('Inbound SMS received:', JSON.stringify(payload))
        break

      default:
        console.log('Unknown iTextMo webhook event:', JSON.stringify(payload))
    }

    return json({
      success: true,
      received: true,
    })
  } catch (error) {
    console.error('iTextMo webhook error:', error)

    return json(
      {
        success: false,
        error: 'Webhook processing failed',
      },
      500,
    )
  }
})