import { createContext, useContext } from 'react'
import type { Session } from '../lib/auth'

export interface AuthContextValue {
  session: Session | null
  loading: boolean
  login: (email: string, password: string) => Promise<Session>
  register: (input: {
    fullName: string
    email: string
    phone: string
    password: string
  }) => Promise<Session>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
