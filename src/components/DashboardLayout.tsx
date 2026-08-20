import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../hooks/useAuth'

const ROLE_LABEL: Record<string, string> = {
  patient: 'Patient',
  doctor: 'Doctor',
  nurse: 'Nurse',
  staff: 'Healthcare Staff',
  admin: 'Administrator',
}

export function DashboardLayout({ title, children }: { title: string; children: ReactNode }) {
  const { session, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = async () => {
    await logout()
    navigate('/', { replace: true })
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-800">{title}</h1>
            {session && (
              <p className="text-sm text-gray-500">
                {session.fullName} · {ROLE_LABEL[session.role]}
              </p>
            )}
          </div>
          <button
            onClick={handleLogout}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            Logout
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  )
}

// Placeholder card listing what this role WILL be able to do (from RBAC table).
export function ComingSoon({ capabilities }: { capabilities: string[] }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-gray-800">Coming soon</h2>
      <p className="mt-1 text-sm text-gray-500">
        Mga magagawa mo dito kapag kumpleto na ang system: / What you'll be able to do here:
      </p>
      <ul className="mt-4 space-y-2">
        {capabilities.map((c) => (
          <li key={c} className="flex items-start gap-2 text-gray-700">
            <span aria-hidden="true" className="mt-0.5 text-emerald-600">
              ✓
            </span>
            {c}
          </li>
        ))}
      </ul>
    </div>
  )
}
