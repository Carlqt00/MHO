import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { errorMessage } from '../lib/errors'

// Patient self-registration ONLY. Staff/doctor/nurse/admin accounts are
// created by the administrator, never through this page.

// Explicit format check — do NOT rely on the browser's type="email" alone
// (it accepts things like "a@b" with no TLD). One @, no whitespace, a dot in
// the domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isValidEmail = (value: string) => EMAIL_RE.test(value.trim())

// PH mobile subscriber number: exactly 10 digits, starts with 9. The +63
// country code is rendered as a static prefix and is NOT part of this value.
const isValidPhone = (digits: string) => /^9\d{9}$/.test(digits)

// Strip everything but digits, then fold common paste formats down to the bare
// 10-digit subscriber number BEFORE capping:
//   09171234567   → drop leading 0
//   639171234567  → drop leading 63
//   +639171234567 → the + is stripped, then the 63 rule applies
// A valid number always starts with 9, so neither a leading 0 nor a leading 63
// can belong to a real subscriber number — dropping them is safe.
function normalizePhoneInput(raw: string): string {
  let digits = raw.replace(/\D/g, '')
  if (digits.startsWith('63')) digits = digits.slice(2)
  else if (digits.startsWith('0')) digits = digits.slice(1)
  return digits.slice(0, 10)
}

export function Register() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('') // bare 10-digit subscriber number
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState('')
  const [phoneError, setPhoneError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const handleEmailChange = (value: string) => {
    setEmail(value)
    // Clear the notice the moment the value becomes valid — never wait for
    // another blur to reward the fix.
    if (emailError && isValidEmail(value)) setEmailError('')
  }

  const handleEmailBlur = () => {
    // Only complain once the field has content; "required" covers the empty
    // case, and we don't want an error on an untouched field.
    if (email.trim() && !isValidEmail(email)) {
      setEmailError('Mukhang mali ang email. Halimbawa: juan@gmail.com')
    }
  }

  const handlePhoneChange = (value: string) => {
    const digits = normalizePhoneInput(value)
    setPhone(digits)
    if (phoneError && isValidPhone(digits)) setPhoneError('')
  }

  const handlePhoneBlur = () => {
    if (phone && !isValidPhone(phone)) {
      setPhoneError('Dapat 10 numero at nagsisimula sa 9. Halimbawa: 917 123 4567')
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    // Re-run validation at submit so a never-blurred field can't slip through.
    const cleanedEmail = email.trim().toLowerCase()
    let ok = true
    if (!isValidEmail(cleanedEmail)) {
      setEmailError('Mukhang mali ang email. Halimbawa: juan@gmail.com')
      ok = false
    }
    if (!isValidPhone(phone)) {
      setPhoneError('Dapat 10 numero at nagsisimula sa 9. Halimbawa: 917 123 4567')
      ok = false
    }
    if (!ok) return

    setError('')
    setBusy(true)
    try {
      // Assemble the canonical +639XXXXXXXXX only now, at submit — the stored
      // value is never the bare 10 digits and never carries a leading 0.
      await register({ fullName, email: cleanedEmail, phone: `+63${phone}`, password })
      navigate('/patient', { replace: true })
    } catch (err) {
      setError(errorMessage(err, 'May problema sa pag-register. Subukan ulit.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-emerald-50 px-6 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="text-emerald-700 hover:underline">
          ← Bumalik sa home
        </Link>
        <div className="mt-4 rounded-2xl bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-bold text-gray-900">Gumawa ng Account</h1>
          <p className="mt-1 text-gray-600">Para sa mga pasyente ng Daraga MHO.</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-5" noValidate>
            <div>
              <label htmlFor="fullName" className="block text-base font-medium text-gray-700">
                Buong Pangalan
              </label>
              <input
                id="fullName"
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-3 text-base focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="email" className="block text-base font-medium text-gray-700">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => handleEmailChange(e.target.value)}
                onBlur={handleEmailBlur}
                aria-invalid={emailError ? true : undefined}
                aria-describedby={emailError ? 'email-error' : undefined}
                className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-3 text-base focus:border-emerald-500 focus:outline-none"
              />
              {emailError && (
                <p id="email-error" className="mt-1 text-sm text-red-600">
                  {emailError}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="phone" className="block text-base font-medium text-gray-700">
                Cellphone Number
              </label>
              <div className="mt-1 flex items-center rounded-lg border border-gray-300 focus-within:border-emerald-500">
                <span className="select-none border-r border-gray-300 px-3 py-3 text-base text-gray-500">
                  +63
                </span>
                <input
                  id="phone"
                  type="tel"
                  inputMode="numeric"
                  required
                  maxLength={10}
                  placeholder="917 123 4567"
                  value={phone}
                  onChange={(e) => handlePhoneChange(e.target.value)}
                  onBlur={handlePhoneBlur}
                  aria-invalid={phoneError ? true : undefined}
                  aria-describedby={phoneError ? 'phone-error' : undefined}
                  className="w-full flex-1 rounded-r-lg px-4 py-3 text-base focus:outline-none"
                />
              </div>
              <div className="mt-1 flex items-center justify-between">
                {phoneError ? (
                  <p id="phone-error" className="text-sm text-red-600">
                    {phoneError}
                  </p>
                ) : (
                  <span />
                )}
                {/* A hard 10-digit cap otherwise feels like a broken keyboard —
                    show the count so the limit is visible. */}
                <span className="text-sm text-gray-500">{phone.length}/10</span>
              </div>
            </div>
            <div>
              <label htmlFor="password" className="block text-base font-medium text-gray-700">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-3 text-base focus:border-emerald-500 focus:outline-none"
              />
              <p className="mt-1 text-sm text-gray-500">Hindi bababa sa 8 characters.</p>
            </div>

            {error && (
              <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-red-700">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-emerald-600 px-6 py-4 text-lg font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {busy ? 'Sandali lang…' : 'Mag-register'}
            </button>
          </form>

          <p className="mt-6 text-center text-gray-600">
            May account na?{' '}
            <Link to="/login" className="font-medium text-emerald-700 hover:underline">
              Mag-login
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
