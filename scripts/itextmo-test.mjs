#!/usr/bin/env node
// Send one SMS straight to the iTextMo gateway using the credentials in .env,
// bypassing Supabase entirely. Use it to answer "do the credentials work?"
// separately from "does the Edge Function work?".
//
//   node scripts/itextmo-test.mjs                      # device status only, sends nothing
//   node scripts/itextmo-test.mjs 09171234567          # send a default test message
//   node scripts/itextmo-test.mjs 09171234567 "Hello"  # send a custom message
//   (number and message may be given in either order)
//
// Reads ITEXTMO_PASSWORD (the sk_live_ key) from .env. The endpoint is the dev
// backend's /api/v1 — the non-dev host 307-redirects there. NOT a browser
// page on purpose: the gateway refuses requests carrying Origin/Referer
// (BROWSER_ORIGIN_REJECTED) and treats a key seen from a browser as leaked.
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const BASE = 'https://itextmo-backend-dev.vercel.app/api/v1'

function loadEnv() {
  const env = {}
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // fall through — env vars may be set in the shell instead
  }
  return { ...env, ...process.env }
}

function toCanonical(raw) {
  let d = String(raw).replace(/\D/g, '')
  if (d.startsWith('63')) d = d.slice(2)
  else if (d.startsWith('0')) d = d.slice(1)
  return /^9\d{9}$/.test(d) ? `+63${d}` : null
}

const env = loadEnv()
const key = env.ITEXTMO_PASSWORD || env.ITEXTMO_API_KEY
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }

async function call(label, url, init) {
  const started = Date.now()
  const res = await fetch(url, { headers, ...init })
  const text = await res.text()
  console.log(`\n${label} → HTTP ${res.status} in ${Date.now() - started} ms`)
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2))
  } catch {
    console.log(text.slice(0, 500))
  }
  return res
}

// No process.exit(): on Windows, exiting while a fetch socket is still open
// trips a libuv assertion (UV_HANDLE_CLOSING). Set exitCode and return instead.
async function main() {
  if (!key) {
    console.error('Missing ITEXTMO_PASSWORD (or ITEXTMO_API_KEY) in .env')
    return 1
  }

  // Number and message in either order: whichever arg parses as a PH mobile
  // number is the recipient; everything else is the message.
  const args = process.argv.slice(2)
  const recipientIdx = args.findIndex((a) => toCanonical(a))
  const to = recipientIdx >= 0 ? toCanonical(args[recipientIdx]) : null
  const messageParts = args.filter((_, i) => i !== recipientIdx)

  const device = await call('GET /device', `${BASE}/device`)
  if (device.status === 401) {
    console.error('\nKey rejected (INVALID_CREDENTIALS). Check ITEXTMO_PASSWORD in .env.')
    return 1
  }

  if (args.length === 0) {
    console.log('\nNo recipient given — nothing sent. Pass a number to send a test SMS.')
    return 0
  }
  if (!to) {
    console.error(
      `\nNone of the arguments is a PH mobile number (09XXXXXXXXX / +639XXXXXXXXX): ${args
        .map((a) => JSON.stringify(a))
        .join(', ')}`
    )
    console.error('Example: node scripts/itextmo-test.mjs 09171234567 "Hello this is a test"')
    return 1
  }

  const body =
    messageParts.join(' ') ||
    `MHO Malilipot: gateway test ${new Date().toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila' })}`

  await call(`POST /messages → ${to}`, `${BASE}/messages`, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': `mho-test-${randomUUID()}` },
    body: JSON.stringify({ to, body, client_ref: `cli-test-${Date.now()}` }),
  })

  console.log(
    '\n202 = queued at the gateway. It reaches the phone only when the gateway handset is online (see device.delivery above).'
  )
  return 0
}

process.exitCode = await main()
