// ============================================================
// auth.ts — Supabase auth implementation.
//
// This is the ONLY file that changed when swapping from mock auth.
// signIn / registerPatient / signOut signatures are identical.
// AuthProvider, useAuth, pages, and routing are all unchanged.
// ============================================================

import { supabase } from './supabase'
import { errorMessage } from './errors'

export type Role = 'patient' | 'doctor' | 'nurse' | 'staff' | 'admin'

export interface Session {
  userId: string
  fullName: string
  role: Role
  email: string | null
  passwordChangeRequired: boolean
}

async function fetchProfile(userId: string): Promise<Session> {
  const { data, error } = await supabase
    .from('profiles')
    .select('full_name, role, email')
    .eq('id', userId)
    .maybeSingle()

  if (error) throw new Error(errorMessage(error, 'Could not load your profile.'))
  if (!data) throw new Error('Profile not found — try logging out and in again.')

  const { data: flagData } = await supabase
    .from('profiles')
    .select('password_change_required')
    .eq('id', userId)
    .maybeSingle()

  return {
    userId,
    fullName: data.full_name,
    role: data.role as Role,
    email: data.email,
    passwordChangeRequired: Boolean(
      (flagData as { password_change_required?: boolean } | null)?.password_change_required
    ),
  }
}

export async function getStoredSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession()
  if (!data.session) return null
  return fetchProfile(data.session.user.id)
}

export async function signIn(email: string, password: string): Promise<Session> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error)
    throw new Error(
      errorMessage(
        error,
        'Hindi matagumpay ang login. Pakisubukan ulit. / Login failed — please try again.'
      )
    )
  return fetchProfile(data.user.id)
}

// Patient self-registration only. Role defaults to 'patient' via the
// handle_new_user trigger (reads raw_app_meta_data — clients can't set it).
const DUPLICATE_EMAIL_MSG =
  'Ang email na ito ay nakarehistro na. Mag-login na lang. / This email is already registered — please log in instead.'

export async function registerPatient(input: {
  fullName: string
  email: string
  phone: string
  password: string
}): Promise<Session> {
  const { data, error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      data: { full_name: input.fullName, phone: input.phone },
    },
  })

  if (error) {
    if (/already.{0,10}registered|user.{0,10}exists/i.test(error.message)) {
      throw new Error(DUPLICATE_EMAIL_MSG)
    }
    throw new Error(
      errorMessage(
        error,
        'Hindi matagumpay ang registration. Pakisubukan ulit. / Registration failed — please try again.'
      )
    )
  }

  // Anti-enumeration: for an existing email Supabase can return a fake
  // user with NO identities instead of an error. Detect and translate.
  if (data.user && data.user.identities?.length === 0) {
    throw new Error(DUPLICATE_EMAIL_MSG)
  }

  // No session = email confirmation is enabled in the dashboard. Our
  // flow requires it OFF (Authentication → Sign In → Confirm email).
  if (!data.user || !data.session) {
    throw new Error(
      'Hindi makumpleto ang registration. Pakisubukan ulit mamaya. / Registration could not be completed — please try again later.'
    )
  }

  // Build the session directly — no read-back needed. The
  // handle_new_user trigger creates the profile in the SAME
  // transaction as the auth user, and self-signup is always 'patient'.
  return {
    userId: data.user.id,
    fullName: input.fullName.trim(),
    role: 'patient',
    email: input.email,
    passwordChangeRequired: false,
  }
}

export async function changeOwnPassword(input: {
  currentPassword?: string
  newPassword: string
  requireCurrentPassword: boolean
}): Promise<Session> {
  const { data: userData, error: userErr } = await supabase.auth.getUser()
  const email = userData.user?.email
  if (userErr || !userData.user || !email) {
    throw new Error('Kailangan munang mag-login bago magpalit ng password.')
  }

  if (input.requireCurrentPassword) {
    const { error: verifyErr } = await supabase.auth.signInWithPassword({
      email,
      password: input.currentPassword ?? '',
    })
    if (verifyErr) {
      throw new Error('Hindi tama ang kasalukuyang password.')
    }
  }

  const { error: updateErr } = await supabase.auth.updateUser({ password: input.newPassword })
  if (updateErr) {
    throw new Error(
      errorMessage(updateErr, 'Hindi ma-update ang password. Pakisubukan ulit mamaya.')
    )
  }

  const { error: profileErr } = await supabase
    .from('profiles')
    .update({ password_change_required: false })
    .eq('id', userData.user.id)
  if (profileErr) {
    const raw = profileErr.message ?? ''
    if (/password_change_required|schema cache/i.test(raw)) return fetchProfile(userData.user.id)
    throw new Error(errorMessage(profileErr, 'Password updated, but profile update failed.'))
  }

  return fetchProfile(userData.user.id)
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut()
}
