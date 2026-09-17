import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DashboardLayout } from '../components/DashboardLayout'
import { useAuth } from '../hooks/useAuth'
import { changeOwnPassword } from '../lib/auth'
import { DASHBOARD_PATH } from '../lib/routes'
import { errorMessage } from '../lib/errors'

const MIN_PASSWORD_LENGTH = 8

export function ChangePassword() {
  const { session, refreshSession } = useAuth()
  const navigate = useNavigate()
  const forced = Boolean(session?.passwordChangeRequired)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [busy, setBusy] = useState(false)

  const validate = () => {
    if (!forced && !currentPassword) return 'Ilagay ang kasalukuyang password.'
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return `Dapat hindi bababa sa ${MIN_PASSWORD_LENGTH} characters ang bagong password.`
    }
    if (newPassword !== confirmPassword) return 'Hindi magkapareho ang dalawang password.'
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
      const updated = await changeOwnPassword({
        currentPassword,
        newPassword,
        requireCurrentPassword: !forced,
      })
      await refreshSession()
      setSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      if (forced) {
        setTimeout(() => navigate(DASHBOARD_PATH[updated.role], { replace: true }), 1200)
      }
    } catch (err) {
      setError(errorMessage(err, 'Hindi mapalitan ang password. Pakisubukan ulit.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DashboardLayout title={forced ? 'Create a New Password' : 'Change Password'}>
      <div className="mx-auto max-w-md">
        {!forced && (
          <Link
            to={session ? DASHBOARD_PATH[session.role] : '/login'}
            className="text-sm font-medium text-emerald-800 hover:text-emerald-950"
          >
            ← Back to Dashboard
          </Link>
        )}
        <section className="card card-pad mt-4">
          <h2 className="text-2xl font-bold text-slate-950">
            {forced ? 'Create a New Password' : 'Change Password'}
          </h2>
          {forced && (
            <p className="mt-2 leading-7 text-slate-600">
              Your account is using a temporary password. Create your own password to continue.
            </p>
          )}

          {success && (
            <div className="alert-success mt-5" role="status">
              Password changed successfully.
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-5" noValidate>
            {!forced && (
              <div>
                <label htmlFor="currentPassword" className="label">
                  Current Password
                </label>
                <input
                  id="currentPassword"
                  type="password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="form-control"
                />
              </div>
            )}
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
        </section>
      </div>
    </DashboardLayout>
  )
}
