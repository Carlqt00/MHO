import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { submitPasswordResetRequest } from '../lib/api'
import {
  isValidPhilippineMobileSubscriber,
  normalizePhilippineMobileSubscriber,
  toCanonicalPhilippineMobile,
} from '../lib/phone'

const NEUTRAL_SUCCESS_MESSAGE =
  'If the information matches an account, a 6-digit code will be sent by SMS to the registered cellphone number.'

export function ForgotPassword() {
  const navigate = useNavigate()
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [nameError, setNameError] = useState('')
  const [phoneError, setPhoneError] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    if (!fullName.trim()) {
      setNameError('Enter your full name.')
      return
    }
    const canonicalPhone = toCanonicalPhilippineMobile(phone)
    if (!canonicalPhone) {
      setPhoneError('Enter the registered cellphone number. Example: 917 123 4567')
      return
    }

    setNameError('')
    setPhoneError('')
    setError('')
    setBusy(true)
    try {
      const result = await submitPasswordResetRequest({
        full_name: fullName,
        phone: canonicalPhone,
      })
      if (!result.verified || !result.requestId) {
        setError('We could not verify an account with the information provided.')
        return
      }
      if (!result.smsSent) {
        setError(
          'Na-verify ang account ninyo, pero hindi maipadala ang SMS code ngayon. Pakisubukan muli mamaya o makipag-ugnayan sa MHO. / Your account was verified, but the SMS code could not be sent right now. Please try again later or contact MHO.'
        )
        return
      }
      setSent(true)
      navigate('/reset-password', {
        state: {
          requestId: result.requestId,
          phoneHint: result.phoneHint ?? '',
          expiresAt: result.expiresAt ?? '',
        },
      })
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
                Enter your full name and registered cellphone number. We will text a 6-digit code
                to your registered cellphone number.
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
