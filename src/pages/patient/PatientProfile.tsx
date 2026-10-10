import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { DashboardLayout } from '../../components/DashboardLayout'
import { TicketCard } from '../../components/TicketCard'
import { useAuth } from '../../hooks/useAuth'
import {
  fetchMyProfile,
  fetchMyAppointmentHistory,
  promoteDefaultEmailContact,
  promoteDefaultPhoneContact,
  updateMyProfile,
  type PatientProfile as PatientProfileData,
  type Appointment,
} from '../../lib/api'
import { updateOwnPassword, verifyOwnPassword } from '../../lib/auth'
import { normalizePhilippineMobileSubscriber, toCanonicalPhilippineMobile } from '../../lib/phone'

function formatSlot(iso: string) {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

const STATUS_LABEL: Record<string, string> = {
  booked: 'Booked',
  checked_in: 'Naka-check in',
  served: 'Done',
  completed: 'Done',
  cancelled: 'Cancelled',
  no_show: 'Hindi dumating',
}

const STATUS_COLOR: Record<string, string> = {
  booked: 'bg-emerald-100 text-emerald-800',
  checked_in: 'bg-blue-100 text-blue-800',
  served: 'bg-gray-100 text-gray-600',
  completed: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-600',
  no_show: 'bg-orange-100 text-orange-700',
}

// Current booking = business that isn't finished yet (booked, plus checked_in
// once the patient has arrived). History = finished business only. These two
// sets are disjoint and cover every status, so nothing overlaps or disappears.
const CURRENT_STATUSES = new Set(['booked', 'checked_in'])
const HISTORY_STATUSES = new Set(['served', 'completed', 'no_show', 'cancelled'])

function profilePhoneSubscriber(profile: PatientProfileData | null): string {
  return profile?.phone ? normalizePhilippineMobileSubscriber(profile.phone) : ''
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 8
type ContactPromotionTarget = { type: 'email' | 'phone'; value: string } | null

function hasDisallowedEmailCharacters(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0)
    return code <= 31 || code === 127 || (code >= 0x200B && code <= 0x200D) || code === 0xFEFF
  })
}

function profileUpdateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/no longer available|refresh and try again/i.test(message)) {
    return message
  }
  if (/additional email must be different|duplicate|unique/i.test(message)) {
    return 'That contact is already saved. Please use a different email or number.'
  }
  if (/valid additional email|valid email/i.test(message)) {
    return 'Please enter a valid email address.'
  }
  if (/selected email address is not valid/i.test(message)) {
    return 'The selected email address is not valid. Please remove it and add the email again.'
  }
  if (/already your default email/i.test(message)) {
    return 'This email is already your default email.'
  }
  if (/already associated with another account/i.test(message)) {
    return 'This email is already associated with another account.'
  }
  if (/confirm the new email|confirmation required|email confirmation/i.test(message)) {
    return 'Please confirm the new email before it becomes your default login email.'
  }
  if (/too many email-change attempts|rate.?limit|try again later/i.test(message)) {
    return 'Too many email-change attempts. Please try again later.'
  }
  if (/session has expired|sign in again|reauth/i.test(message)) {
    return 'Your session has expired. Please sign in again, then try updating your default email.'
  }
  if (/philippine|cellphone|phone/i.test(message)) {
    return 'Please enter a valid Philippine cellphone number.'
  }
  if (/auth|email|otp|confirmation/i.test(message)) {
    return 'Could not update your default email. Please try again or contact MHO.'
  }
  return message || 'Could not update your profile. Please try again.'
}

export function PatientProfile() {
  const { session, refreshSession } = useAuth()
  const userId = session?.userId

  const [profile, setProfile] = useState<PatientProfileData | null>(null)
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editEmail, setEditEmail] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [additionalEmails, setAdditionalEmails] = useState<string[]>([])
  const [additionalPhones, setAdditionalPhones] = useState<string[]>([])
  const [newAdditionalEmail, setNewAdditionalEmail] = useState('')
  const [newAdditionalPhone, setNewAdditionalPhone] = useState('')
  const [changePasswordOpen, setChangePasswordOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [editError, setEditError] = useState('')
  const [promotionTarget, setPromotionTarget] = useState<ContactPromotionTarget>(null)

  useEffect(() => {
    if (!userId) return
    Promise.all([fetchMyProfile(userId), fetchMyAppointmentHistory()])
      .then(([p, appts]) => {
        setProfile(p)
        setEditEmail(p.email ?? '')
        setEditPhone(profilePhoneSubscriber(p))
        setAdditionalEmails(p.additional_emails)
        setAdditionalPhones(p.additional_phones)
        setAppointments(appts)
        setLoading(false)
      })
      .catch((e: Error) => {
        setError(e.message)
        setLoading(false)
      })
  }, [userId])

  const startEdit = () => {
    setEditError('')
    setNotice('')
    setEditEmail(profile?.email ?? '')
    setEditPhone(profilePhoneSubscriber(profile))
    setAdditionalEmails(profile?.additional_emails ?? [])
    setAdditionalPhones(profile?.additional_phones ?? [])
    setNewAdditionalEmail('')
    setNewAdditionalPhone('')
    setChangePasswordOpen(false)
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setPromotionTarget(null)
    setEditMode(true)
  }

  const cancelEdit = () => {
    setEditError('')
    setEditEmail(profile?.email ?? '')
    setEditPhone(profilePhoneSubscriber(profile))
    setAdditionalEmails(profile?.additional_emails ?? [])
    setAdditionalPhones(profile?.additional_phones ?? [])
    setNewAdditionalEmail('')
    setNewAdditionalPhone('')
    setChangePasswordOpen(false)
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setPromotionTarget(null)
    setEditMode(false)
  }

  const addAdditionalEmail = () => {
    const normalized = newAdditionalEmail.trim().toLowerCase()
    setEditError('')
    if (!normalized) return
    if (hasDisallowedEmailCharacters(newAdditionalEmail)) {
      setEditError('Please remove hidden or invalid characters from the email address.')
      return
    }
    if (!EMAIL_RE.test(normalized)) {
      setEditError('Please enter a valid additional email address.')
      return
    }
    if (normalized === editEmail.trim().toLowerCase()) {
      setEditError('Additional email must be different from your primary email.')
      return
    }
    if (!additionalEmails.includes(normalized)) {
      setAdditionalEmails((emails) => [...emails, normalized])
    }
    setNewAdditionalEmail('')
  }

  const addAdditionalPhone = () => {
    const canonical = toCanonicalPhilippineMobile(newAdditionalPhone)
    setEditError('')
    if (!newAdditionalPhone.trim()) return
    if (!canonical) {
      setEditError('Enter a valid additional Philippine cellphone number. Example: 9171234567.')
      return
    }
    const primaryPhone = toCanonicalPhilippineMobile(editPhone)
    if (primaryPhone && canonical === primaryPhone) {
      setEditError('Additional contact number must be different from your primary number.')
      return
    }
    if (!additionalPhones.includes(canonical)) {
      setAdditionalPhones((phones) => [...phones, canonical])
    }
    setNewAdditionalPhone('')
  }

  const applyProfileState = (nextProfile: PatientProfileData) => {
    setProfile(nextProfile)
    setEditEmail(nextProfile.email ?? '')
    setEditPhone(profilePhoneSubscriber(nextProfile))
    setAdditionalEmails(nextProfile.additional_emails)
    setAdditionalPhones(nextProfile.additional_phones)
  }

  const openEmailPromotionTarget = (rowValue: string) => {
    const targetValue = rowValue.trim().toLowerCase()
    console.info('[default-email-promotion]', {
      stage: 'row-click',
      rowValue: targetValue,
    })
    setEditError('')
    setNotice('')
    setPromotionTarget({ type: 'email', value: targetValue })
    console.info('[default-email-promotion]', {
      stage: 'modal-open',
      targetValue,
    })
  }

  const openPhonePromotionTarget = (rowValue: string) => {
    setEditError('')
    setNotice('')
    setPromotionTarget({ type: 'phone', value: rowValue })
  }

  const confirmPromotion = async () => {
    if (!promotionTarget) return
    setSaving(true)
    setEditError('')
    setNotice('')
    try {
      if (promotionTarget.type === 'email') {
        const currentPrimary = (profile?.email ?? '').trim().toLowerCase()
        const selectedEmail = promotionTarget.value.trim().toLowerCase()
        console.info('[default-email-promotion]', {
          stage: 'confirm-promotion',
          currentPrimary,
          selectedEmail,
        })
        if (selectedEmail === currentPrimary) {
          setNotice('This email is already your default email.')
          setPromotionTarget(null)
          return
        }
        const result = await promoteDefaultEmailContact(selectedEmail)
        applyProfileState(result.profile)
        await refreshSession()
        setEditError('')
        setNotice(
          result.emailAlreadyDefault
            ? 'This email is already your default email.'
            : result.emailConfirmationRequired
            ? 'Please confirm the new email before it becomes your default login email.'
            : 'Default email updated successfully.'
        )
      } else {
        const nextProfile = await promoteDefaultPhoneContact(promotionTarget.value)
        applyProfileState(nextProfile)
        setEditError('')
        setNotice('Default cellphone number updated successfully.')
      }
      setPromotionTarget(null)
    } catch (e) {
      setEditError(profileUpdateErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const validatePasswordChange = () => {
    if (!changePasswordOpen) return ''
    if (!currentPassword) return 'Current password is required.'
    if (!newPassword) return 'New password is required.'
    if (!confirmPassword) return 'Confirm new password is required.'
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return 'New password must be at least 8 characters.'
    }
    if (newPassword !== confirmPassword) return 'New passwords do not match.'
    if (newPassword === currentPassword) {
      return 'New password must be different from your current password.'
    }
    return ''
  }

  const saveProfile = async () => {
    setSaving(true)
    setEditError('')
    setNotice('')
    try {
      const passwordError = validatePasswordChange()
      if (passwordError) {
        setEditError(passwordError)
        return
      }
      if (changePasswordOpen) {
        await verifyOwnPassword(currentPassword)
      }

      const result = await updateMyProfile({
        email: editEmail,
        phone: editPhone,
        additionalEmails,
        additionalPhones,
      })
      if (changePasswordOpen) {
        await updateOwnPassword(newPassword)
      }
      const savedProfile = userId ? await fetchMyProfile(userId) : result.profile
      setProfile(savedProfile)
      setEditEmail(savedProfile.email ?? '')
      setEditPhone(profilePhoneSubscriber(savedProfile))
      setAdditionalEmails(savedProfile.additional_emails)
      setAdditionalPhones(savedProfile.additional_phones)
      setNewAdditionalEmail('')
      setNewAdditionalPhone('')
      setChangePasswordOpen(false)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      await refreshSession()
      setEditMode(false)
      setNotice(
        changePasswordOpen
          ? 'Profile and password updated successfully.'
          : result.emailConfirmationRequired
          ? 'Confirmation is required before this email becomes your default email. Please check your inbox.'
          : 'Profile updated successfully.'
      )
    } catch (e) {
      setEditError(profileUpdateErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const { current, history } = useMemo(() => {
    const current = appointments
      .filter((a) => CURRENT_STATUSES.has(a.status))
      .sort(
        (a, b) =>
          new Date(a.time_slots.slot_datetime).getTime() -
          new Date(b.time_slots.slot_datetime).getTime()
      ) // soonest first

    const history = appointments
      .filter((a) => HISTORY_STATUSES.has(a.status))
      .sort(
        (a, b) =>
          new Date(b.time_slots.slot_datetime).getTime() -
          new Date(a.time_slots.slot_datetime).getTime()
      ) // most recent first

    return { current, history }
  }, [appointments])

  return (
    <DashboardLayout title="Profile">
      <div className="mb-6">
        <Link to="/patient" className="text-sm font-medium text-emerald-800 hover:text-emerald-950">
          ← Back to Dashboard
        </Link>
      </div>

      {error && (
        <div className="alert-error mb-4">{error}</div>
      )}

      {notice && (
        <div className="alert-success mb-4" role="status">{notice}</div>
      )}

      {promotionTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 px-4 py-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="profile-promotion-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-emerald-100 bg-white p-5 shadow-xl shadow-slate-950/15">
            <h2 id="profile-promotion-title" className="text-base font-semibold text-slate-900">
              {promotionTarget.type === 'email'
                ? `Set ${promotionTarget.value} as your default email?`
                : `Set ${promotionTarget.value} as your default cellphone number?`}
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              {promotionTarget.type === 'email'
                ? 'This will also become your login email.'
                : 'Future SMS notifications will be sent to this number.'}
            </p>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setPromotionTarget(null)}
                disabled={saving}
                className="btn-secondary min-h-10 w-full px-4 py-2 sm:w-auto"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmPromotion}
                disabled={saving}
                className="btn-primary min-h-10 w-full px-4 py-2 sm:w-auto"
              >
                {saving ? 'Updating...' : 'Set as Default'}
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-slate-400">Loading…</p>
      ) : (
        <div className="space-y-8">
          {/* 1. Basic profile info */}
          <section className="card card-pad">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="section-title">Basic Info</h2>
              {!editMode && (
                <button type="button" onClick={startEdit} className="btn-secondary w-full sm:w-auto">
                  Edit
                </button>
              )}
            </div>
            {editMode ? (
              <div className="mx-auto max-w-3xl space-y-4">
                {editError && <div className="alert-error">{editError}</div>}
                <div className="space-y-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Name</p>
                    <p className="mt-1 break-words text-base font-semibold text-slate-900">
                      {profile?.full_name || '—'}
                    </p>
                  </div>

                  <label className="block">
                    <span className="label">Email</span>
                    <input
                      type="email"
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      className="mt-1 h-11 w-full rounded-lg border border-slate-200 px-3 text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                      placeholder="name@example.com"
                      disabled={saving}
                    />
                  </label>

                  <div>
                    <span className="label">Additional Email</span>
                    <div className="mt-1 flex min-w-0 flex-col gap-2 sm:flex-row">
                      <input
                        type="email"
                        value={newAdditionalEmail}
                        onChange={(e) => setNewAdditionalEmail(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addAdditionalEmail()
                          }
                        }}
                        className="h-11 min-w-0 flex-1 rounded-lg border border-slate-200 px-3 text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                        placeholder="Enter additional email"
                        disabled={saving}
                      />
                      <button
                        type="button"
                        onClick={addAdditionalEmail}
                        disabled={saving}
                        className="btn-secondary h-11 w-full shrink-0 sm:w-24"
                      >
                        + Add
                      </button>
                    </div>
                    {additionalEmails.length > 0 && (
                      <div className="mt-3 space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                          Added Emails
                        </p>
                        {additionalEmails.map((email) => (
                          <div
                            key={email}
                            className="flex min-w-0 flex-col gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <span className="min-w-0 break-all text-sm font-medium text-slate-700">{email}</span>
                            <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                              <button
                                type="button"
                                onClick={() => openEmailPromotionTarget(email)}
                                disabled={saving}
                                className="min-h-8 rounded-md border border-emerald-200 bg-white px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-60"
                              >
                                Set as Default
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setAdditionalEmails((emails) =>
                                    emails.filter((savedEmail) => savedEmail !== email)
                                  )
                                }
                                disabled={saving}
                                className="min-h-8 rounded-md px-3 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 hover:text-red-700 disabled:opacity-60"
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <label className="block">
                    <span className="label">Cellphone Number</span>
                    <div className="mt-1 flex h-11 min-w-0 overflow-hidden rounded-lg border border-slate-200 focus-within:border-emerald-500 focus-within:ring-4 focus-within:ring-emerald-100">
                      <span className="flex items-center border-r border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-500">
                        +63
                      </span>
                      <input
                        inputMode="numeric"
                        value={editPhone}
                        onChange={(e) => setEditPhone(normalizePhilippineMobileSubscriber(e.target.value))}
                        className="min-w-0 flex-1 px-3 text-slate-900 outline-none"
                        placeholder="9094445123"
                        disabled={saving}
                      />
                    </div>
                  </label>

                  <div>
                    <span className="label">Additional Contact Number</span>
                    <div className="mt-1 flex min-w-0 flex-col gap-2 sm:flex-row">
                      <div className="flex h-11 min-w-0 flex-1 overflow-hidden rounded-lg border border-slate-200 focus-within:border-emerald-500 focus-within:ring-4 focus-within:ring-emerald-100">
                        <span className="flex shrink-0 items-center border-r border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-500">
                          +63
                        </span>
                        <input
                          inputMode="numeric"
                          value={newAdditionalPhone}
                          onChange={(e) => setNewAdditionalPhone(normalizePhilippineMobileSubscriber(e.target.value))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              addAdditionalPhone()
                            }
                          }}
                          className="min-w-0 flex-1 px-3 text-slate-900 outline-none"
                          placeholder="9672345672"
                          disabled={saving}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={addAdditionalPhone}
                        disabled={saving}
                        className="btn-secondary h-11 w-full shrink-0 sm:w-24"
                      >
                        + Add
                      </button>
                    </div>
                    {additionalPhones.length > 0 && (
                      <div className="mt-3 space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                          Added Numbers
                        </p>
                        {additionalPhones.map((phone) => (
                          <div
                            key={phone}
                            className="flex min-w-0 flex-col gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <span className="min-w-0 break-all text-sm font-medium text-slate-700">{phone}</span>
                            <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                              <button
                                type="button"
                                onClick={() => openPhonePromotionTarget(phone)}
                                disabled={saving}
                                className="min-h-8 rounded-md border border-emerald-200 bg-white px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-60"
                              >
                                Set as Default
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setAdditionalPhones((phones) =>
                                    phones.filter((savedPhone) => savedPhone !== phone)
                                  )
                                }
                                disabled={saving}
                                className="min-h-8 rounded-md px-3 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 hover:text-red-700 disabled:opacity-60"
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="border-t border-slate-200 pt-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <h3 className="text-sm font-semibold text-slate-700">Security</h3>
                    <button
                      type="button"
                      onClick={() => {
                        setChangePasswordOpen((open) => !open)
                        setCurrentPassword('')
                        setNewPassword('')
                        setConfirmPassword('')
                        setEditError('')
                      }}
                      disabled={saving}
                      className="btn-secondary min-h-10 w-full px-4 py-2 sm:w-auto"
                      aria-expanded={changePasswordOpen}
                    >
                      Change Password
                    </button>
                  </div>

                  {changePasswordOpen && (
                    <div className="mt-3 grid grid-cols-1 gap-4 rounded-lg border border-slate-100 bg-slate-50/60 p-3 lg:grid-cols-3">
                      <label className="block">
                        <span className="label">Current Password</span>
                        <input
                          type="password"
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          className="mt-1 h-11 w-full rounded-lg border border-slate-200 px-3 text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                          disabled={saving}
                          autoComplete="current-password"
                        />
                      </label>
                      <label className="block">
                        <span className="label">New Password</span>
                        <input
                          type="password"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          className="mt-1 h-11 w-full rounded-lg border border-slate-200 px-3 text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                          disabled={saving}
                          minLength={MIN_PASSWORD_LENGTH}
                          autoComplete="new-password"
                        />
                        <p className="mt-1 text-sm text-slate-500">
                          At least {MIN_PASSWORD_LENGTH} characters.
                        </p>
                      </label>
                      <label className="block">
                        <span className="label">Confirm New Password</span>
                        <input
                          type="password"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          className="mt-1 h-11 w-full rounded-lg border border-slate-200 px-3 text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                          disabled={saving}
                          minLength={MIN_PASSWORD_LENGTH}
                          autoComplete="new-password"
                        />
                      </label>
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={cancelEdit}
                    disabled={saving}
                    className="btn-secondary w-full sm:w-auto"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveProfile}
                    disabled={saving}
                    className="btn-primary w-full sm:w-auto"
                  >
                    {saving ? 'Saving…' : 'Save Changes'}
                  </button>
                </div>
              </div>
            ) : (
              <dl className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 px-4 py-3 md:col-span-2">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Name</dt>
                  <dd className="mt-1 break-words text-base font-semibold text-slate-900">
                    {profile?.full_name || '—'}
                  </dd>
                </div>
                <div className="rounded-xl border border-slate-100 bg-white px-4 py-3 shadow-sm shadow-emerald-950/5">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Primary Email</dt>
                  <dd className="mt-1 flex min-w-0 flex-wrap items-center gap-2 break-all text-sm font-medium text-slate-900">
                    {profile?.email ? (
                      <a href={`mailto:${profile.email}`} className="hover:text-emerald-800">
                        {profile.email}
                      </a>
                    ) : (
                      '—'
                    )}
                    {profile?.email && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                        Default
                      </span>
                    )}
                  </dd>
                  {profile?.additional_emails && profile.additional_emails.length > 0 && (
                    <div className="mt-3 border-t border-slate-100 pt-3">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Additional Email{profile.additional_emails.length === 1 ? '' : 's'}
                      </dt>
                      <div className="mt-2 space-y-1.5">
                        {profile.additional_emails.map((email) => (
                          <dd key={email} className="break-all text-sm text-slate-700">
                            {email}
                          </dd>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="rounded-xl border border-slate-100 bg-white px-4 py-3 shadow-sm shadow-emerald-950/5">
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Primary Cellphone Number
                  </dt>
                  <dd className="mt-1 flex min-w-0 flex-wrap items-center gap-2 break-all text-sm font-medium text-slate-900">
                    <span>{profile?.phone || '—'}</span>
                    {profile?.phone && (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                        Default
                      </span>
                    )}
                  </dd>
                  {profile?.additional_phones && profile.additional_phones.length > 0 && (
                    <div className="mt-3 border-t border-slate-100 pt-3">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Additional Contact Number{profile.additional_phones.length === 1 ? '' : 's'}
                      </dt>
                      <div className="mt-2 space-y-1.5">
                        {profile.additional_phones.map((phone) => (
                          <dd key={phone} className="break-all text-sm text-slate-700">
                            {phone}
                          </dd>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </dl>
            )}
          </section>

          {/* 2. Current booking(s) with queue number + QR check-in code */}
          <section>
            <h2 className="mb-4 section-title">Current Appointment</h2>
            {current.length === 0 ? (
              <div className="empty-state">
                Wala kang kasalukuyang appointment. / You have no current appointment.
              </div>
            ) : (
              <div className="space-y-4">
                {current.map((appt) => (
                  <CurrentBookingCard key={appt.id} appt={appt} />
                ))}
              </div>
            )}
          </section>

          {/* 3. Appointment history — finished business only, most recent first */}
          <section>
            <h2 className="mb-4 section-title">Appointment History</h2>
            {history.length === 0 ? (
              <div className="empty-state">
                Wala ka pang nakaraang appointment. / You have no past appointments yet.
              </div>
            ) : (
              <div className="table-shell">
                <table className="data-table mobile-card-table">
                  <thead>
                    <tr>
                      <th className="px-4 py-3 font-medium">Date</th>
                      <th className="px-4 py-3 font-medium">Service</th>
                      <th className="px-4 py-3 font-medium">Provider</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((appt) => (
                      <tr key={appt.id}>
                        <td data-label="Date" className="text-slate-700">
                          {formatDate(appt.time_slots.slot_datetime)}
                        </td>
                        <td data-label="Service" className="text-slate-700">{appt.services.name}</td>
                        <td data-label="Provider" className="text-slate-700">
                          {appt.providers.profiles.full_name}
                        </td>
                        <td data-label="Status" className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[appt.status] ?? 'bg-gray-100 text-gray-600'}`}
                          >
                            {STATUS_LABEL[appt.status] ?? appt.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </DashboardLayout>
  )
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[status] ?? 'bg-gray-100 text-gray-600'}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

function CurrentBookingCard({ appt }: { appt: Appointment }) {
  // Same source the confirmation screen uses (queue_tickets, created at
  // booking). The fetch normalizes the embed to a single object (or null).
  const ticket = appt.queue_tickets

  // Ticket present: echo the confirmation screen's ticket, compact.
  if (ticket) {
    return (
      <TicketCard
        size="compact"
        ticketNumber={ticket.ticket_number}
        serviceName={appt.services.name}
        dateLabel={formatSlot(appt.time_slots.slot_datetime)}
        providerName={appt.providers.profiles.full_name}
        qrCode={ticket.qr_code}
        status={<StatusBadge status={appt.status} />}
      />
    )
  }

  // Tickets are issued at booking, so a missing ticket is an anomaly — degrade
  // to the appointment details with a note rather than crash or show nothing.
  return (
    <div className="card card-pad">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold text-slate-900">{appt.services.name}</p>
        <StatusBadge status={appt.status} />
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {appt.providers.profiles.full_name} · {formatSlot(appt.time_slots.slot_datetime)}
      </p>
      <p className="mt-2 text-sm text-slate-500">
        Wala pang queue number na naitalaga. Ipakita ang booking na ito sa reception ng MHO. / No
        queue number assigned yet — please show this booking at the MHO reception.
      </p>
    </div>
  )
}
