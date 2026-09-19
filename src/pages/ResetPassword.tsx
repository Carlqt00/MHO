import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { completePasswordReset } from '../lib/api'
import { errorMessage } from '../lib/errors'

const MIN_PASSWORD_LENGTH = 8
const CODE_LENGTH = 6

interface ResetState {
  requestId: string
  phoneHint: string
  expiresAt: string
}

function readState(value: unknown): ResetState | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if (typeof obj.requestId !== 'string' || !obj.requestId) return null
  return {
    requestId: obj.requestId,
    phoneHint: typeof obj.phoneHint === 'string' ? obj.phoneHint : '',
    expiresAt: typeof obj.expiresAt === 'string' ? obj.expiresAt : '',
  }
}

function expiryLabel(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' })
}

export function ResetPassword() {
  const location = useLocation()
  const reset = readState(location.state)
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [busy, setBusy] = useState(false)

  const validate = () => {
    if (code.length !== CODE_LENGTH) return `Enter the ${CODE_LENGTH}-digit code from the SMS.`
    if (!newPassword || !confirmPassword) return 'Both password fields are required.'
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    }
    if (newPassword !== confirmPassword) return 'Passwords do not match.'
    return ''
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!reset) return
    const message = validate()
    if (message) {
      setError(message)
      return
    }

    setError('')
    setBusy(true)
    try {
      await completePasswordReset({ requestId: reset.requestId, code, newPassword })
      setSuccess(true)
      setCode('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setError(errorMessage(err, 'Could not change the password. Please request a new code.'))
    } finally {
      setBusy(false)
    }
  }

  const expiry = reset ? expiryLabel(reset.expiresAt) : ''

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-md">
        <Link to="/login" className="text-sm font-medium text-emerald-800 hover:text-emerald-950">
          ← Back to Login
        </Link>
        <div className="card card-pad mt-4">
          {success ? (
            <>
              <h1 className="text-2xl font-bold text-slate-950">Password changed successfully.</h1>
              <p className="mt-2 leading-7 text-slate-600">
                You can now log in using your new password.
              </p>
              <Link to="/login" className="btn-primary mt-6 w-full py-4 text-base">
                Back to Login
              </Link>
            </>
          ) : !reset ? (
            <>
              <h1 className="text-2xl font-bold text-slate-950">Reset code required</h1>
              <p className="mt-2 leading-7 text-slate-600">
                Start from Forgot Password so we can text a code to your registered cellphone
                number.
              </p>
              <Link to="/forgot-password" className="btn-primary mt-6 w-full py-4 text-base">
                Forgot Password?
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-slate-950">Enter the SMS code</h1>
              <p className="mt-2 leading-7 text-slate-600">
                Nagpadala kami ng {CODE_LENGTH}-digit code sa{' '}
                <span className="font-medium text-slate-900">{reset.phoneHint || 'your cellphone'}</span>.
                {expiry ? ` Valid until ${expiry}.` : ''}
              </p>
              <form onSubmit={handleSubmit} className="mt-6 space-y-5" noValidate>
                <div>
                  <label htmlFor="code" className="label">
                    Reset Code
                  </label>
                  <input
                    id="code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    maxLength={CODE_LENGTH}
                    placeholder="123456"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))}
                    className="form-control text-center text-2xl tracking-[0.5em]"
                  />
                </div>
                <div>
                  <label htmlFor="newPassword" className="label">
                    New Password
                  </label>
                  <input
                    id="newPassword"
                    type="password"
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="form-control"
                  />
                  <p className="mt-1 text-sm text-slate-500">
                    Hindi bababa sa {MIN_PASSWORD_LENGTH} characters.
                  </p>
                </div>
                <div>
                  <label htmlFor="confirmPassword" className="label">
                    Confirm New Password
                  </label>
                  <input
                    id="confirmPassword"
                    type="password"
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="form-control"
                  />
                </div>

                {error && (
                  <p role="alert" className="alert-error">
                    {error}
                  </p>
                )}

                <button type="submit" disabled={busy} className="btn-primary w-full py-4 text-base">
                  {busy ? 'Changing…' : 'Change Password'}
                </button>
              </form>
              <p className="mt-4 text-center text-sm text-slate-500">
                Hindi dumating ang code?{' '}
                <Link to="/forgot-password" className="font-medium text-emerald-800 hover:text-emerald-950">
                  Humiling muli
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
