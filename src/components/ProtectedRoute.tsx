import { Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../hooks/useAuth'
import { DASHBOARD_PATH } from '../lib/routes'
import type { Role } from '../lib/auth'

interface Props {
  allow: Role[]
  children: ReactNode
}

export function ProtectedRoute({ allow, children }: Props) {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-gray-400">
        Loading…
      </div>
    )
  }

  if (!session) return <Navigate to="/login" replace />
  if (!allow.includes(session.role)) {
    return <Navigate to={DASHBOARD_PATH[session.role]} replace />
  }
  return children
}
