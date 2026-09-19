import { Link, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../hooks/useAuth'

const ROLE_LABEL: Record<string, string> = {
  patient: 'Patient',
  doctor: 'Doctor',
  nurse: 'Nurse',
  staff: 'Healthcare Staff',
  admin: 'Administrator',
}

export function DashboardLayout({
  title,
  children,
  wide = false,
}: {
  title: string
  children: ReactNode
  wide?: boolean
}) {
  const { session, logout } = useAuth()
  const navigate = useNavigate()
  const shellClass = wide ? 'page-shell' : 'mx-auto w-full max-w-6xl px-3 sm:px-5 lg:px-8'

  const handleLogout = async () => {
    await logout()
    navigate('/', { replace: true })
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-emerald-100 bg-white/85 py-4 shadow-sm shadow-emerald-950/5 backdrop-blur">
        <div className={`${shellClass} flex flex-wrap items-center justify-between gap-3`}>
          <div className="brand-lockup min-w-0 flex-1">
            <span className="brand-mark h-10 w-10 sm:h-11 sm:w-11">MHO</span>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold leading-tight text-slate-950 sm:text-xl">{title}</h1>
            {session && (
              <p className="break-words text-sm font-normal text-slate-500">
                {session.fullName} · {ROLE_LABEL[session.role]}
              </p>
            )}
            </div>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 min-[420px]:w-auto sm:gap-3">
            {session?.role === 'patient' && (
              <Link
                to="/patient/profile"
                className="btn-subtle flex-1 min-[420px]:flex-none"
              >
                Profile
              </Link>
            )}
            <button
              onClick={handleLogout}
              className="btn-subtle flex-1 min-[420px]:flex-none"
            >
              Logout
            </button>
          </div>
        </div>
      </header>
      <main className={`${shellClass} py-6 sm:py-8`}>{wide ? children : <div className="content-shell">{children}</div>}</main>
    </div>
  )
}

// Placeholder card listing what this role WILL be able to do (from RBAC table).
export function ComingSoon({ capabilities }: { capabilities: string[] }) {
  return (
    <div className="card card-pad">
      <h2 className="section-title">Coming soon</h2>
      <p className="mt-1 muted">
        Mga magagawa mo dito kapag kumpleto na ang system: / What you'll be able to do here:
      </p>
      <ul className="mt-4 space-y-2">
        {capabilities.map((c) => (
          <li key={c} className="flex items-start gap-2 text-slate-700">
            <span aria-hidden="true" className="mt-0.5 text-emerald-700">
              ✓
            </span>
            {c}
          </li>
        ))}
      </ul>
    </div>
  )
}
