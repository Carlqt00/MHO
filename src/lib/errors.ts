// Named CHECK/constraint violations (SQLSTATE 23514 et al.) that we want to
// surface with a specific, friendly message instead of the generic fallback.
// Keyed on the constraint name, which Postgres includes in the raw message
// ("violates check constraint \"<name>\""). These run BEFORE RAW_DB_NOISE so
// the backstop can't swallow them; the backstop still covers every unnamed or
// unmapped case. Add new constraints here as they gain a user-facing message.
const CONSTRAINT_MESSAGES: Array<[RegExp, string]> = [
  [
    /profiles_phone_ph_format_chk/i,
    'Mali ang format ng cellphone number. Dapat PH mobile na nagsisimula sa 9 (10 numero). / Invalid phone number — must be a PH mobile number starting with 9.',
  ],
  // Booking guard (a): same service, same calendar day (migration 0011).
  [
    /uniq_active_service_per_patient_day/i,
    'May booking ka na para sa serbisyong ito sa petsang ito. Pumili ng ibang petsa o serbisyo. / You already have a booking for this service on this date.',
  ],
  // Booking guard (b): two active bookings in the same time slot (migration 0011).
  [
    /uniq_active_time_per_patient/i,
    'May booking ka na sa oras na ito. Pumili ng ibang oras. / You already have a booking at this time.',
  ],
]

// Raw Postgres / RLS internals that must never reach an end user. Specific,
// friendlier messages are translated at the call site (see api.ts) BEFORE this
// runs; this pattern is the catch-all backstop so anything unhandled degrades
// to the caller's fallback instead of leaking constraint names or SQL text.
const RAW_DB_NOISE =
  /(duplicate key value|violates (?:unique|check|foreign key|not-null|exclusion) constraint|violates row-level security|permission denied for|new row for relation .* violates)/i

// Converts any thrown value into a human-readable message.
// Supabase's auth client JSON.stringifies empty error bodies, which
// produces messages like "{}" — treat those as missing and use the
// fallback instead.
export function errorMessage(err: unknown, fallback: string): string {
  let raw = ''
  if (typeof err === 'string') {
    raw = err
  } else if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>
    for (const key of ['message', 'error_description', 'msg', 'error']) {
      if (typeof obj[key] === 'string' && obj[key]) {
        raw = obj[key] as string
        break
      }
    }
  }
  const cleaned = raw.trim()
  if (!cleaned || /^[{}[\]\s,"']*$/.test(cleaned)) return fallback
  // Specific constraint messages run first — before the raw-noise backstop
  // would otherwise degrade them to the generic fallback.
  for (const [pattern, message] of CONSTRAINT_MESSAGES) {
    if (pattern.test(cleaned)) return message
  }
  if (RAW_DB_NOISE.test(cleaned)) return fallback
  return cleaned
}
