// ============================================================
// race-test.mjs — proves the race-safe booking guarantee.
//
// Fires 10 SIMULTANEOUS book_appointment RPCs on the SAME slot
// from two different patient accounts. Each RPC is its own
// Postgres transaction on its own connection, so this is a true
// concurrent race on the SELECT ... FOR UPDATE lock.
//
// Expected: exactly 1 success, 9 clean ERR_ALREADY_BOOKED errors.
// Cleans up after itself (cancels the winning appointment).
//
// Run:  node scripts/race-test.mjs
// ============================================================

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// Parse .env without extra dependencies
const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
)

const URL_ = env.VITE_SUPABASE_URL
const KEY = env.VITE_SUPABASE_ANON_KEY
if (!URL_ || !KEY) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env')
  process.exit(1)
}

const PASSWORD = 'demo1234'
const CALLS = 10

async function login(email) {
  const client = createClient(URL_, KEY, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`Login failed for ${email}: ${error.message}`)
  return client
}

async function main() {
  console.log('Signing in patient@demo.mho and patient2@demo.mho …')
  const [juan, elena] = await Promise.all([
    login('patient@demo.mho'),
    login('patient2@demo.mho'),
  ])

  // Pick one open future slot
  const { data: slots, error: slotErr } = await juan
    .from('time_slots')
    .select('id, slot_datetime')
    .eq('is_booked', false)
    .gte('slot_datetime', new Date().toISOString())
    .order('slot_datetime')
    .limit(1)
  if (slotErr || !slots?.length) throw new Error(`No open slot found: ${slotErr?.message}`)

  const slot = slots[0]
  console.log(`Target slot: ${slot.id} at ${slot.slot_datetime}`)
  console.log(`Firing ${CALLS} concurrent book_appointment calls …\n`)

  // Build all promises first, then race them — no awaits in between,
  // so the HTTP requests genuinely overlap.
  const callers = Array.from({ length: CALLS }, (_, i) => (i % 2 === 0 ? juan : elena))
  const results = await Promise.all(
    callers.map((client, i) =>
      client
        .rpc('book_appointment', { p_slot_id: slot.id })
        .then(({ data, error }) => ({ i, who: i % 2 === 0 ? 'Juan' : 'Elena', data, error }))
    )
  )

  const wins = results.filter((r) => !r.error && r.data)
  const losses = results.filter((r) => r.error)

  for (const r of results) {
    if (r.error) {
      console.log(`  call ${r.i} (${r.who}): BLOCKED — ${r.error.message}`)
    } else {
      console.log(
        `  call ${r.i} (${r.who}): SUCCESS — ticket ${r.data.ticket_number}, queue #${r.data.queue_position}`
      )
    }
  }

  // Independent DB verification: exactly one active appointment on the slot
  const { count } = await juan
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('slot_id', slot.id)
    .neq('status', 'cancelled')

  console.log(`\nActive appointments on slot (via DB count): ${count}`)

  // Cleanup: winner cancels, restoring the slot
  if (wins.length === 1) {
    const winner = wins[0]
    const client = winner.who === 'Juan' ? juan : elena
    const { error: cancelErr } = await client.rpc('cancel_appointment', {
      p_appointment_id: winner.data.appointment_id,
    })
    console.log(
      cancelErr
        ? `Cleanup FAILED: ${cancelErr.message}`
        : 'Cleanup: winning appointment cancelled, slot freed.'
    )
  }

  const cleanLosses = losses.every((r) => r.error.message.includes('ERR_ALREADY_BOOKED'))
  const pass = wins.length === 1 && losses.length === CALLS - 1 && cleanLosses && count === 1

  console.log(
    `\n${pass ? '✅ PASS' : '❌ FAIL'}: ${wins.length} success, ${losses.length} clean rejections (expected 1 / ${CALLS - 1})`
  )
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('Test crashed:', e.message)
  process.exit(1)
})
