import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchPasswordResetRequests,
  type PasswordResetRequest,
} from '../../lib/api'
import type { Role } from '../../lib/auth'

const ROLE_LABEL: Record<Role, string> = {
  patient: 'Patient',
  doctor: 'Doctor',
  nurse: 'Nurse',
  staff: 'Healthcare Staff',
  admin: 'Administrator',
}

const STATUS_BADGE: Record<PasswordResetRequest['status'], string> = {
  pending: 'bg-amber-100 text-amber-800',
  completed: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-slate-100 text-slate-600',
  approved: 'bg-blue-100 text-blue-800',
  expired: 'bg-orange-100 text-orange-700',
  failed: 'bg-red-100 text-red-700',
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function AdminPasswordResets() {
  const [requests, setRequests] = useState<PasswordResetRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchRequests = useCallback(
    () =>
      fetchPasswordResetRequests()
        .then((data) => {
          setRequests(data)
          setError('')
        })
        .catch(() =>
          setError(
            'Could not load password reset requests. Check that the latest database migration has been applied.'
          )
        )
        .finally(() => setLoading(false)),
    []
  )

  useEffect(() => {
    fetchRequests()
  }, [fetchRequests])

  const activeCount = useMemo(
    () => requests.filter((request) => request.status === 'pending' || request.status === 'approved').length,
    [requests]
  )

  return (
    <section>
      <div>
        <h2 className="section-title">Password Reset Requests</h2>
        <p className="mt-1 muted">Monitor automatic password reset requests.</p>
      </div>

      <div className="mt-4 rounded-2xl border border-emerald-100 bg-white/80 px-4 py-3 text-sm text-slate-700">
        Active requests: <span className="font-semibold text-slate-950">{activeCount}</span>
      </div>

      {error && (
        <div className="alert-error mt-4" role="alert">
          {error}
        </div>
      )}

      <div className="table-shell mt-4">
        <table className="data-table min-w-[52rem]">
          <thead>
            <tr>
              <th>Email / Identifier</th>
              <th>Full Name</th>
              <th>Role</th>
              <th>Requested</th>
              <th>Status</th>
              <th>Completed</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                  Loading requests…
                </td>
              </tr>
            ) : requests.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                  No password reset requests yet.
                </td>
              </tr>
            ) : (
              requests.map((request) => <PasswordResetRow key={request.id} request={request} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function PasswordResetRow({ request }: { request: PasswordResetRequest }) {
  const statusLabel = request.status.charAt(0).toUpperCase() + request.status.slice(1)

  return (
    <tr className="align-top">
      <td className="break-all text-slate-600">{request.profiles.email ?? '—'}</td>
      <td className="font-medium text-slate-900">{request.profiles.full_name}</td>
      <td className="text-slate-600">{ROLE_LABEL[request.profiles.role]}</td>
      <td className="text-slate-500">{formatDateTime(request.requested_at)}</td>
      <td>
        <span
          className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[request.status]}`}
        >
          {statusLabel}
        </span>
      </td>
      <td className="text-slate-500">
        {request.completed_at ? formatDateTime(request.completed_at) : '—'}
      </td>
    </tr>
  )
}
