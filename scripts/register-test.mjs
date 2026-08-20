// ============================================================
// register-test.mjs — verifies the registration fixes.
//
// Test A: duplicate email (patient2@demo.mho) → clean duplicate error
// Test B: brand-new email → session returned, profiles + patients
//         rows exist with role 'patient'
//
// Run:  node scripts/register-test.mjs
// Cleanup of the test user (SQL editor):
//   delete from auth.users where email like 'reg-test-%@demo.mho';
// ============================================================

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
)

const client = () =>
  createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── Test A: duplicate email ──────────────────────────────────
console.log('Test A: signUp with existing email (patient2@demo.mho)')
{
  const { data, error } = await client().auth.signUp({
    email: 'patient2@demo.mho',
    password: 'demo1234',
    options: { data: { full_name: 'Dup Test', phone: '0917' } },
  })
  const explicitError = !!error && /already.{0,10}registered|user.{0,10}exists/i.test(error.message)
  const fakeUser = !!data?.user && data.user.identities?.length === 0
  check(
    'duplicate is detectable (explicit error OR empty-identities fake user)',
    explicitError || fakeUser,
    explicitError ? `error: "${error.message}"` : fakeUser ? 'fake user, identities: []' : `unexpected: err=${error?.message} ids=${data?.user?.identities?.length}`
  )
}

// ── Test B: fresh registration ───────────────────────────────
// NOTE: must be a real-looking domain — GoTrue rejects fake TLDs
// (like .mho) for NEW signups. Seeded users bypassed this via SQL.
const email = `reg.test.${Date.now()}@gmail.com`
console.log(`\nTest B: fresh registration (${email})`)
{
  const c = client()
  const { data, error } = await c.auth.signUp({
    email,
    password: 'demo1234',
    options: { data: { full_name: 'Reg Test User', phone: '09991234567' } },
  })

  check('no signUp error', !error, error?.message)
  check('session returned (email confirmations OFF)', !!data?.session)
  check('user has identities', (data?.user?.identities?.length ?? 0) > 0)

  if (data?.session) {
    // Read back through RLS as the new user
    const { data: profile } = await c
      .from('profiles')
      .select('full_name, role')
      .eq('id', data.user.id)
      .maybeSingle()
    check('profiles row exists (trigger ran)', !!profile)
    check('role is patient', profile?.role === 'patient', `role=${profile?.role}`)
    check('full_name saved', profile?.full_name === 'Reg Test User', `got "${profile?.full_name}"`)

    const { data: patientRow } = await c
      .from('patients')
      .select('id')
      .eq('profile_id', data.user.id)
      .maybeSingle()
    check('patients row exists (trigger ran)', !!patientRow)
  }
}

console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`)
console.log(`Cleanup: delete from auth.users where email = '${email}';`)
process.exit(failures === 0 ? 0 : 1)
