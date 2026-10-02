import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { DARAGA_BARANGAYS, isDaragaBarangay } from '../lib/daragaBarangays'
import { errorMessage } from '../lib/errors'
import {
  isValidPhilippineMobileSubscriber,
  normalizePhilippineMobileSubscriber,
  toCanonicalPhilippineMobile,
} from '../lib/phone'

// Patient self-registration ONLY. Staff/doctor/nurse/admin accounts are
// created by the administrator, never through this page.

// Explicit format check — do NOT rely on the browser's type="email" alone
// (it accepts things like "a@b" with no TLD). One @, no whitespace, a dot in
// the domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isValidEmail = (value: string) => EMAIL_RE.test(value.trim())
const PRIVACY_NOTICE_VERSION = '1.0'

export function Register() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('') // bare 10-digit subscriber number
  const [barangay, setBarangay] = useState('')
  const [purok, setPurok] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState('')
  const [phoneError, setPhoneError] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [error, setError] = useState('')
  const [showPrivacyModal, setShowPrivacyModal] = useState(false)
  const [consentNotice, setConsentNotice] = useState('')
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
    const digits = normalizePhilippineMobileSubscriber(value)
    setPhone(digits)
    if (phoneError && isValidPhilippineMobileSubscriber(digits)) setPhoneError('')
  }

  const handlePhoneBlur = () => {
    if (phone && !isValidPhilippineMobileSubscriber(phone)) {
      setPhoneError('Dapat 10 numero at nagsisimula sa 9. Halimbawa: 917 123 4567')
    }
  }

  const validateForm = () => {
    // Re-run validation at submit so a never-blurred field can't slip through.
    const cleanedEmail = email.trim().toLowerCase()
    let ok = true
    setFieldError('')
    if (!isValidEmail(cleanedEmail)) {
      setEmailError('Mukhang mali ang email. Halimbawa: juan@gmail.com')
      ok = false
    }
    const canonicalPhone = toCanonicalPhilippineMobile(phone)
    if (!canonicalPhone) {
      setPhoneError('Dapat 10 numero at nagsisimula sa 9. Halimbawa: 917 123 4567')
      ok = false
    }
    if (!fullName.trim()) {
      setFieldError('Pakilagay ang buong pangalan.')
      ok = false
    } else if (!isDaragaBarangay(barangay)) {
      setFieldError('Please select your Barangay.')
      ok = false
    } else if (!purok.trim()) {
      setFieldError('Pakilagay ang Purok.')
      ok = false
    } else if (password.length < 8) {
      setFieldError('Dapat hindi bababa sa 8 characters ang password.')
      ok = false
    }
    return ok
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    setError('')
    setConsentNotice('')
    if (!validateForm()) return
    setShowPrivacyModal(true)
  }

  const handleDisagree = () => {
    setShowPrivacyModal(false)
    setConsentNotice('You must agree to the User & Privacy Guidelines to create an account.')
  }

  const handleAgree = async () => {
    setError('')
    setConsentNotice('')
    if (!validateForm()) {
      setShowPrivacyModal(false)
      return
    }

    const cleanedEmail = email.trim().toLowerCase()
    const canonicalPhone = toCanonicalPhilippineMobile(phone)
    if (!canonicalPhone) return

    setBusy(true)
    try {
      // Assemble the canonical +639XXXXXXXXX only now, at submit — the stored
      // value is never the bare 10 digits and never carries a leading 0.
      await register({
        fullName: fullName.trim(),
        email: cleanedEmail,
        phone: canonicalPhone,
        barangay: barangay.trim(),
        purok: purok.trim(),
        password,
        privacyConsentAccepted: true,
        privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
      })
      navigate('/patient', { replace: true })
    } catch (err) {
      setError(errorMessage(err, 'May problema sa pag-register. Subukan ulit.'))
      setShowPrivacyModal(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-md">
        <Link to="/" className="text-sm font-medium text-emerald-800 hover:text-emerald-950">
          ← Bumalik sa home
        </Link>
        <div className="card card-pad mt-4">
          <h1 className="text-2xl font-bold text-slate-950">Gumawa ng Account</h1>
          <p className="mt-1 text-slate-600">Para sa mga pasyente ng Daraga MHO.</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-5" noValidate>
            <div>
              <label htmlFor="fullName" className="label">
                Buong Pangalan
              </label>
              <input
                id="fullName"
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="form-control"
              />
            </div>
            <div>
              <label htmlFor="email" className="label">
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
                className="form-control"
              />
              {emailError && (
                <p id="email-error" className="mt-1 text-sm text-red-600">
                  {emailError}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="phone" className="label">
                Cellphone Number
              </label>
              <div className="flex items-center rounded-xl border border-slate-200 bg-white shadow-sm transition focus-within:border-emerald-500 focus-within:ring-4 focus-within:ring-emerald-100">
                <span className="select-none border-r border-slate-200 px-3 py-2.5 text-sm text-slate-500">
                  +63
                </span>
                <input
                  id="phone"
                  type="tel"
                  inputMode="numeric"
                  required
                  maxLength={16}
                  placeholder="917 123 4567"
                  value={phone}
                  onChange={(e) => handlePhoneChange(e.target.value)}
                  onBlur={handlePhoneBlur}
                  aria-invalid={phoneError ? true : undefined}
                  aria-describedby={phoneError ? 'phone-error' : undefined}
                  className="w-full min-w-0 flex-1 rounded-r-xl px-3.5 py-2.5 text-sm text-slate-800 focus:outline-none"
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
                <span className="text-sm text-slate-500">{phone.length}/10</span>
              </div>
            </div>
            <div>
              <label htmlFor="barangay" className="label">
                Barangay
              </label>
              <select
                id="barangay"
                required
                value={barangay}
                onChange={(e) => setBarangay(e.target.value)}
                className="form-control"
              >
                <option value="">Select Barangay</option>
                {DARAGA_BARANGAYS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="purok" className="label">
                Purok
              </label>
              <input
                id="purok"
                type="text"
                required
                value={purok}
                onChange={(e) => setPurok(e.target.value)}
                className="form-control"
                placeholder="Enter Purok"
              />
            </div>
            <div>
              <label htmlFor="password" className="label">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="form-control"
              />
              <p className="mt-1 text-sm text-slate-500">Hindi bababa sa 8 characters.</p>
            </div>

            {fieldError && (
              <p role="alert" className="alert-error">
                {fieldError}
              </p>
            )}

            {consentNotice && (
              <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {consentNotice}
              </p>
            )}

            {error && (
              <p role="alert" className="alert-error">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="btn-primary w-full py-4 text-base"
            >
              {busy ? 'Sandali lang…' : 'Mag-register'}
            </button>
          </form>

          <p className="mt-6 text-center text-slate-600">
            May account na?{' '}
            <Link to="/login" className="font-medium text-emerald-800 hover:text-emerald-950">
              Mag-login
            </Link>
          </p>
        </div>
      </div>

      {showPrivacyModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-4 py-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="privacy-guidelines-title"
        >
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-4 sm:px-6">
              <h2 id="privacy-guidelines-title" className="text-xl font-bold text-slate-950">
                User & Privacy Guidelines
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Before creating your account, please review how your information will be used in
                the MHO Daraga Appointment and Ticketing System.
              </p>
            </div>

            <div className="space-y-5 overflow-y-auto px-5 py-5 text-sm leading-6 text-slate-700 sm:px-6">
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
                  Information We Collect
                </h3>
                <p className="mt-2">
                  The system may collect information needed to create and manage your account and
                  appointments, including:
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>Full Name</li>
                  <li>Email Address</li>
                  <li>Cellphone Number</li>
                  <li>Barangay</li>
                  <li>Purok</li>
                  <li>Appointment information</li>
                  <li>Queue/ticket information</li>
                </ul>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
                  Purpose
                </h3>
                <p className="mt-2">This information is used to provide MHO services such as:</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>account management</li>
                  <li>appointment scheduling</li>
                  <li>queue and ticket management</li>
                  <li>appointment notifications</li>
                  <li>communication related to MHO services</li>
                </ul>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
                  User Responsibility
                </h3>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>provide accurate information</li>
                  <li>keep account credentials private</li>
                  <li>use the system appropriately</li>
                  <li>update contact information when necessary</li>
                </ul>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
                  Privacy
                </h3>
                <p className="mt-2">
                  Personal information should only be accessed and processed according to the
                  system&apos;s authorized MHO operations and applicable privacy requirements.
                </p>
              </section>
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              <button
                type="button"
                onClick={handleDisagree}
                disabled={busy}
                className="btn-secondary w-full sm:w-auto"
              >
                I Disagree
              </button>
              <button
                type="button"
                onClick={handleAgree}
                disabled={busy}
                className="btn-primary w-full sm:w-auto"
              >
                {busy ? 'Creating account…' : 'I Agree'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
