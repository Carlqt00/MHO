import { useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { completePasswordReset } from '../lib/api'
import { errorMessage } from '../lib/errors'

const MIN_PASSWORD_LENGTH = 8

export function ResetPassword() {
  const location = useLocation()
  const resetToken =
    typeof location.state === 'object' && location.state && 'resetToken' in location.state
      ? String(location.state.resetToken)
      : ''
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [busy, setBusy] = useState(false)

  const validate = () => {
    if (!newPassword || !confirmPassword) return 'Both password fields are required.'
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    }
    if (newPassword !== confirmPassword) return 'Passwords do not match.'
    return ''
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const message = validate()
    if (message) {
      setError(message)
      return
    }

    setError('')
    setBusy(true)
    try {
      await completePasswordReset({ resetToken, newPassword })
      setSuccess(true)
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setError(errorMessage(err, 'Could not change the password. Please request a new reset.'))
    } finally {
      setBusy(false)
    }
  }

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
          ) : !resetToken ? (
            <>
              <h1 className="text-2xl font-bold text-slate-950">Reset authorization required</h1>
              <p className="mt-2 leading-7 text-slate-600">
                Start from Forgot Password to verify your account before creating a new password.
              </p>
              <Link to="/forgot-password" className="btn-primary mt-6 w-full py-4 text-base">
                Forgot Password?
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-slate-950">Create New Password</h1>
              <form onSubmit={handleSubmit} className="mt-6 space-y-5" noValidate>
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}
