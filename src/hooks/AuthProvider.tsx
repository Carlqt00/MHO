import { useState, useEffect, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import * as auth from '../lib/auth'
import type { Session } from '../lib/auth'
import { AuthContext } from './useAuth'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 1. Hydrate on mount
    auth.getStoredSession()
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setLoading(false))

    // 2. Keep in sync with Supabase auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, supabaseSession) => {
        if (!supabaseSession) {
          setSession(null)
        } else {
          try {
            const s = await auth.getStoredSession()
            setSession(s)
          } catch {
            // Transient profile-fetch failure with a live Supabase
            // session (e.g. right after signUp) — keep current state
            // instead of booting the user to login.
          }
        }
        setLoading(false)
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  const login = async (email: string, password: string) => {
    const s = await auth.signIn(email, password)
    setSession(s)
    return s
  }

  const register = async (input: {
    fullName: string
    email: string
    phone: string
    password: string
  }) => {
    const s = await auth.registerPatient(input)
    setSession(s)
    return s
  }

  const refreshSession = async () => {
    const s = await auth.getStoredSession()
    setSession(s)
    return s
  }

  const logout = async () => {
    await auth.signOut()
    setSession(null)
  }

  return (
    <AuthContext.Provider value={{ session, loading, login, register, refreshSession, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
