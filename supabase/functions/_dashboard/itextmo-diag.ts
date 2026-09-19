// ============================================================
// TEMPORARY DIAGNOSTIC — paste into a new Dashboard function named
// `itextmo-diag` (Verify JWT ON), call it with any signed-in user's JWT, then
// delete the function. It sends NO SMS. It reports what the Edge runtime sees:
// the ITEXTMO_* secrets (endpoint in full — not secret; key as prefix+length),
// and how long outbound requests take from inside Supabase, so a hang can be
// pinned to "wrong endpoint" vs "Supabase cannot reach that host".
// ============================================================

const TIMEOUT_MS = 12_000

async function timed(label: string, url: string, init: RequestInit = {}) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    return {
      label,
      url,
      ok: true,
      status: res.status,
      ms: Date.now() - started,
      finalUrl: res.url,
      redirected: res.redirected,
      server: res.headers.get('server'),
      body: text.slice(0, 160),
    }
  } catch (err) {
    return {
      label,
      url,
      ok: false,
      ms: Date.now() - started,
      error:
        err instanceof DOMException && err.name === 'AbortError'
          ? `TIMEOUT after ${TIMEOUT_MS} ms`
          : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

Deno.serve(async () => {
  const endpoint = Deno.env.get('ITEXTMO_ENDPOINT')?.trim() ?? ''
  const key = Deno.env.get('ITEXTMO_API_KEY')?.trim() ?? ''
  const device = Deno.env.get('ITEXTMO_DEVICE_ID')?.trim() ?? ''

  let endpointOrigin = ''
  let endpointParse = 'ok'
  try {
    endpointOrigin = new URL(endpoint).origin
  } catch (e) {
    endpointParse = `INVALID URL: ${String(e)}`
  }

  const results = []
  // Control: a host that is definitely reachable.
  results.push(await timed('control: example.com', 'https://example.com/'))
  // The dev backend health route, hard-coded (independent of the secret).
  results.push(await timed('dev backend /healthz', 'https://itextmo-backend-dev.vercel.app/healthz'))
  // The configured endpoint's host health route.
  if (endpointOrigin) results.push(await timed('configured origin /healthz', `${endpointOrigin}/healthz`))
  // The configured endpoint exactly as send-sms uses it, with an EMPTY body:
  // a correct setup answers 400 VALIDATION_FAILED quickly and sends nothing.
  if (endpoint) {
    results.push(
      await timed('configured endpoint POST (empty body)', endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `mho-diag-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({}),
      })
    )
  }

  return new Response(
    JSON.stringify(
      {
        env: {
          ITEXTMO_ENDPOINT: endpoint || '(not set)',
          endpointParse,
          ITEXTMO_API_KEY: key ? `${key.slice(0, 8)}… (${key.length} chars)` : '(not set)',
          ITEXTMO_DEVICE_ID: device || '(not set — fine)',
        },
        runtime: { deno: Deno.version.deno, region: Deno.env.get('SB_REGION') ?? Deno.env.get('DENO_REGION') ?? null },
        results,
      },
      null,
      2
    ),
    { headers: { 'Content-Type': 'application/json' } }
  )
})
