import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { DASHBOARD_PATH } from '../lib/routes'
import { errorMessage } from '../lib/errors'

export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const session = await login(email, password)
      navigate(DASHBOARD_PATH[session.role], { replace: true })
    } catch (err) {
      setError(errorMessage(err, 'May problema sa pag-login. Subukan ulit.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-md">
        <Link to="/" className="text-sm font-medium text-emerald-800 hover:text-emerald-950">
          ← Back to Home
        </Link>
        <div className="card card-pad mt-4">
          <h1 className="text-2xl font-bold text-slate-950">Mag-login</h1>
          <p className="mt-1 text-slate-600">Ilagay ang inyong email at password.</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <div>
              <label htmlFor="email" className="label">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="form-control"
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
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="form-control"
              />
              <Link
                to="/forgot-password"
                className="mt-2 inline-block text-sm font-medium text-emerald-800 hover:text-emerald-950"
              >
                Forgot Password?
              </Link>
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
              {busy ? 'Sandali lang…' : 'Login'}
            </button>
          </form>

          <p className="mt-6 text-center text-slate-600">
            Wala pang account?{' '}
            <Link to="/register" className="font-medium text-emerald-800 hover:text-emerald-950">
              Mag-register
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
