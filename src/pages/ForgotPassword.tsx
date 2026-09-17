import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { submitPasswordResetRequest } from '../lib/api'
import {
  isValidPhilippineMobileSubscriber,
  normalizePhilippineMobileSubscriber,
  toCanonicalPhilippineMobile,
} from '../lib/phone'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const NEUTRAL_SUCCESS_MESSAGE =
  'If the information matches an account, you can continue to create a new password.'

function isValidEmail(value: string) {
  return EMAIL_RE.test(value.trim())
}

export function ForgotPassword() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [emailError, setEmailError] = useState('')
  const [nameError, setNameError] = useState('')
  const [phoneError, setPhoneError] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    const cleanedEmail = email.trim().toLowerCase()
    if (!cleanedEmail) {
      setEmailError('Enter your registered email.')
      return
    }
    if (!isValidEmail(cleanedEmail)) {
      setEmailError('Mukhang mali ang email. Halimbawa: juan@gmail.com')
      return
    }
    if (!fullName.trim()) {
      setNameError('Enter your full name.')
      return
    }
    const canonicalPhone = toCanonicalPhilippineMobile(phone)
    if (!canonicalPhone) {
      setPhoneError('Enter the registered cellphone number. Example: 917 123 4567')
      return
    }

    setEmailError('')
    setNameError('')
    setPhoneError('')
    setError('')
    setBusy(true)
    try {
      const result = await submitPasswordResetRequest({
        email: cleanedEmail,
        fullName,
        phone: canonicalPhone,
      })
      if (!result.verified || !result.resetToken) {
        setError('We could not verify the account information. Please check your details or contact MHO.')
        return
      }
      setSent(true)
      navigate('/reset-password', { state: { resetToken: result.resetToken } })
    } catch {
      setError('Could not submit the password reset request. Please try again later.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-md">
        <Link to="/login" className="text-sm font-medium text-emerald-800 hover:text-emerald-950">
          ← Bumalik sa login
        </Link>
        <div className="card card-pad mt-4">
          {sent ? (
            <>
              <h1 className="text-2xl font-bold text-slate-950">Request submitted</h1>
              <p className="mt-2 leading-7 text-slate-600">{NEUTRAL_SUCCESS_MESSAGE}</p>
              <Link to="/login" className="btn-primary mt-6 w-full py-4 text-base">
                Back to Login
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-slate-950">Forgot Password?</h1>
              <p className="mt-2 leading-7 text-slate-600">
                Enter your account information to request a password reset.
              </p>

              <form onSubmit={handleSubmit} className="mt-6 space-y-5" noValidate>
                <div>
                  <label htmlFor="fullName" className="label">
                    Full Name
                  </label>
                  <input
                    id="fullName"
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => {
                      setFullName(e.target.value)
                      if (nameError && e.target.value.trim()) setNameError('')
                    }}
                    aria-invalid={nameError ? true : undefined}
                    aria-describedby={nameError ? 'fullName-error' : undefined}
                    className="form-control"
                  />
                  {nameError && (
                    <p id="fullName-error" className="mt-1 text-sm text-red-600">
                      {nameError}
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="phone" className="label">
                    Registered Cellphone Number
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
                      onChange={(e) => {
                        const digits = normalizePhilippineMobileSubscriber(e.target.value)
                        setPhone(digits)
                        if (phoneError && isValidPhilippineMobileSubscriber(digits)) {
                          setPhoneError('')
                        }
                      }}
                      aria-invalid={phoneError ? true : undefined}
                      aria-describedby={phoneError ? 'phone-error' : undefined}
                      className="w-full min-w-0 flex-1 rounded-r-xl px-3.5 py-2.5 text-sm text-slate-800 focus:outline-none"
                    />
                  </div>
                  {phoneError && (
                    <p id="phone-error" className="mt-1 text-sm text-red-600">
                      {phoneError}
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="email" className="label">
                    Registered Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value)
                      if (emailError && isValidEmail(e.target.value)) setEmailError('')
                    }}
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
                  {busy ? 'Verifying…' : 'Continue'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
