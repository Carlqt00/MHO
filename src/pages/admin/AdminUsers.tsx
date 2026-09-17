import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import {
  fetchAllProfiles,
  adminCreateUser,
  adminUpdateRole,
  type AdminUser,
  type CreateUserResult,
} from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import type { Role } from '../../lib/auth'

const ROLE_OPTIONS: Role[] = ['patient', 'doctor', 'nurse', 'staff', 'admin']

// Shared input/select styling (the project uses inline utilities, no CSS classes).
const inputCls =
  'form-control'

const ROLE_LABEL: Record<Role, string> = {
  patient: 'Patient',
  doctor: 'Doctor',
  nurse: 'Nurse',
  staff: 'Healthcare Staff',
  admin: 'Administrator',
}

const ROLE_BADGE: Record<Role, string> = {
  patient: 'bg-gray-100 text-gray-700',
  doctor: 'bg-emerald-100 text-emerald-800',
  nurse: 'bg-sky-100 text-sky-800',
  staff: 'bg-amber-100 text-amber-800',
  admin: 'bg-indigo-100 text-indigo-800',
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function AdminUsers() {
  const { session } = useAuth()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all')
  const [showAdd, setShowAdd] = useState(false)

  // Async-only: sets state exclusively in promise callbacks, so it's safe to
  // call straight from an effect (no synchronous setState → no cascading render).
  const fetchUsers = useCallback(
    () =>
      fetchAllProfiles()
        .then((data) => {
          setUsers(data)
          setError('')
        })
        .catch((e: unknown) => setError(errorMessage(e, 'Failed to load users.')))
        .finally(() => setLoading(false)),
    []
  )

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  // Event-handler refresh after a mutation: show the spinner, then refetch.
  const reload = useCallback(() => {
    setLoading(true)
    fetchUsers()
  }, [fetchUsers])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter((u) => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false
      if (!q) return true
      return (
        u.full_name.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q)
      )
    })
  }, [users, search, roleFilter])

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="section-title">User &amp; Role Management</h2>
          <p className="mt-1 muted">
            Create staff, provider, and admin accounts and manage their roles.
          </p>
        </div>
        <button
          onClick={() => setShowAdd((s) => !s)}
          className="btn-primary"
        >
          {showAdd ? 'Close' : '+ Add user'}
        </button>
      </div>

      {showAdd && (
        <AddUserForm
          onDone={() => {
            setShowAdd(false)
            reload()
          }}
        />
      )}

      {/* Filters */}
      <div className="mt-6 flex flex-wrap gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or email…"
          className="form-control min-w-[16rem] flex-1"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as Role | 'all')}
          className="form-control w-full sm:w-auto"
        >
          <option value="all">All roles</option>
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="alert-error mt-4" role="alert">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="table-shell mt-4">
        <table className="data-table min-w-[36rem]">
          <thead>
            <tr>
              <th className="px-4 py-3 font-semibold">Name</th>
              <th className="px-4 py-3 font-semibold">Email</th>
              <th className="px-4 py-3 font-semibold">Role</th>
              <th className="px-4 py-3 font-semibold">Created</th>
              <th className="px-4 py-3 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  Loading users…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  No users match your filters.
                </td>
              </tr>
            ) : (
              filtered.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  isSelf={u.id === session?.userId}
                  onChanged={reload}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ── Add user form ────────────────────────────────────────────
function AddUserForm({ onDone }: { onDone: () => void }) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [providerType, setProviderType] = useState<'doctor' | 'dentist'>('doctor')
  const [specialization, setSpecialization] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<CreateUserResult | null>(null)

  const isDoctor = role === 'doctor'
  const isNurse = role === 'nurse'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const created = await adminCreateUser({
        fullName,
        email,
        phone: phone || undefined,
        role,
        providerType: isDoctor ? providerType : undefined,
        specialization: isDoctor || isNurse ? specialization || undefined : undefined,
      })
      setResult(created)
    } catch (err) {
      setError(errorMessage(err, 'Could not create the user.'))
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    return (
      <div className="alert-success mt-4">
        <p className="font-semibold text-emerald-800">Account created</p>
        <p className="mt-1 text-sm text-emerald-700">
          {result.email} · {ROLE_LABEL[result.role]}
        </p>
        {result.generatedPassword && (
        <div className="mt-3 rounded-xl border border-emerald-100 bg-white px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Temporary password (shown once)
            </p>
            <div className="mt-1 flex items-center gap-2">
              <code className="break-all font-mono text-sm text-slate-900">
                {result.generatedPassword}
              </code>
              <button onClick={() => navigator.clipboard?.writeText(result.generatedPassword!)} className="btn-subtle min-h-8 shrink-0 px-2 py-1 text-xs">
                Copy
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Give this to the user and ask them to change it after logging in.
            </p>
          </div>
        )}
        <button
          onClick={onDone}
          className="btn-primary mt-4"
        >
          Done
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="card card-pad mt-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name">
          <input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Email">
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Phone (optional)">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Role">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className={inputCls}
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </Field>
        {isDoctor && (
          <Field label="Provider type">
            <select
              value={providerType}
              onChange={(e) => setProviderType(e.target.value as 'doctor' | 'dentist')}
              className={inputCls}
            >
              <option value="doctor">Doctor</option>
              <option value="dentist">Dentist</option>
            </select>
          </Field>
        )}
        {(isDoctor || isNurse) && (
          <Field label="Specialization (optional)">
            <input
              value={specialization}
              onChange={(e) => setSpecialization(e.target.value)}
              className={inputCls}
            />
          </Field>
        )}
      </div>

      {error && (
        <div className="alert-error mt-4" role="alert">
          {error}
        </div>
      )}

      <div className="mt-4 flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="btn-primary"
        >
          {busy ? 'Creating…' : 'Create user'}
        </button>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        A temporary password is generated and shown once after creation.
      </p>
    </form>
  )
}

// ── One table row, with the inline role-change state machine ──
function UserRow({
  user,
  isSelf,
  onChanged,
}: {
  user: AdminUser
  isSelf: boolean
  onChanged: () => void
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view')
  const [newRole, setNewRole] = useState<Role>(user.role)
  const [providerType, setProviderType] = useState<'doctor' | 'dentist'>('doctor')
  const [specialization, setSpecialization] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reset = () => {
    setMode('view')
    setNewRole(user.role)
    setError('')
  }

  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      await adminUpdateRole({
        userId: user.id,
        role: newRole,
        providerType: newRole === 'doctor' ? providerType : undefined,
        specialization:
          newRole === 'doctor' || newRole === 'nurse' ? specialization || undefined : undefined,
      })
      onChanged()
    } catch (err) {
      setError(errorMessage(err, 'Could not change the role.'))
      setBusy(false)
    }
  }

  return (
    <tr className="align-top">
      <td className="font-medium text-slate-900">
        {user.full_name || <span className="text-slate-400">—</span>}
        {isSelf && <span className="ml-2 text-xs text-slate-400">(you)</span>}
      </td>
      <td className="break-all text-slate-600">{user.email ?? '—'}</td>
      <td>
        <span
          className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${ROLE_BADGE[user.role]}`}
        >
          {ROLE_LABEL[user.role]}
        </span>
      </td>
      <td className="text-slate-500">{formatDate(user.created_at)}</td>
      <td>
        {mode === 'view' && (
          <button
            onClick={() => setMode('edit')}
            disabled={isSelf}
            title={isSelf ? 'You cannot change your own role' : undefined}
            className="btn-subtle min-h-8 px-3 py-1 text-xs"
          >
            Change role
          </button>
        )}

        {mode === 'edit' && (
          <div className="space-y-2">
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as Role)}
              className={inputCls}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            {newRole === 'doctor' && (
              <select
                value={providerType}
                onChange={(e) => setProviderType(e.target.value as 'doctor' | 'dentist')}
                className={inputCls}
              >
                <option value="doctor">Doctor</option>
                <option value="dentist">Dentist</option>
              </select>
            )}
            {(newRole === 'doctor' || newRole === 'nurse') && (
              <input
                value={specialization}
                onChange={(e) => setSpecialization(e.target.value)}
                placeholder="Specialization (optional)"
                className={inputCls}
              />
            )}
            <div className="flex gap-2">
              <button
                onClick={() => setMode('confirm')}
                disabled={newRole === user.role}
                className="btn-primary min-h-8 px-3 py-1 text-xs"
              >
                Review
              </button>
              <button
                onClick={reset}
                className="btn-subtle min-h-8 px-3 py-1 text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {mode === 'confirm' && (
          <div className="space-y-2">
            <p className="text-xs text-gray-600">
              Change <span className="font-medium">{user.full_name}</span> from{' '}
              <span className="font-medium">{ROLE_LABEL[user.role]}</span> to{' '}
              <span className="font-medium">{ROLE_LABEL[newRole]}</span>? Takes effect immediately.
            </p>
            <div className="flex gap-2">
              <button
                onClick={confirm}
                disabled={busy}
              className="btn-primary min-h-8 px-3 py-1 text-xs"
              >
                {busy ? 'Saving…' : 'Confirm'}
              </button>
              <button
                onClick={() => setMode('edit')}
                disabled={busy}
                className="btn-subtle min-h-8 px-3 py-1 text-xs"
              >
                Back
              </button>
            </div>
          </div>
        )}

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </td>
    </tr>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-gray-700">{label}</span>
      {children}
    </label>
  )
}
