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
    <div className="flex min-h-screen items-center justify-center bg-emerald-50 px-6">
      <div className="w-full max-w-md">
        <Link to="/" className="text-emerald-700 hover:underline">
          ← Bumalik sa home
        </Link>
        <div className="mt-4 rounded-2xl bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-bold text-gray-900">Mag-login</h1>
          <p className="mt-1 text-gray-600">Ilagay ang inyong email at password.</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <div>
              <label htmlFor="email" className="block text-base font-medium text-gray-700">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-3 text-base focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-base font-medium text-gray-700">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-4 py-3 text-base focus:border-emerald-500 focus:outline-none"
              />
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
              {busy ? 'Sandali lang…' : 'Login'}
            </button>
          </form>

          <p className="mt-6 text-center text-gray-600">
            Wala pang account?{' '}
            <Link to="/register" className="font-medium text-emerald-700 hover:underline">
              Mag-register
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
