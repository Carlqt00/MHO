import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AdminEmptyState,
  AdminPageHeader,
  AdminStatCard,
  StatusBadge,
} from '../../components/AdminPrimitives'
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

const STATUS_TONE: Record<PasswordResetRequest['status'], 'amber' | 'emerald' | 'slate' | 'sky' | 'orange' | 'red'> = {
  pending: 'amber',
  completed: 'emerald',
  rejected: 'slate',
  approved: 'sky',
  expired: 'orange',
  failed: 'red',
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
    <section className="space-y-6">
      <AdminPageHeader
        title="Password Resets"
        subtitle="Monitor automatic SMS-based password reset requests and completion history."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <AdminStatCard label="Active Requests" value={activeCount} detail="Pending or approved" tone="amber" />
        <AdminStatCard label="Completed" value={requests.filter((r) => r.status === 'completed').length} detail="Finished resets" />
        <AdminStatCard label="Failed / Expired" value={requests.filter((r) => r.status === 'failed' || r.status === 'expired').length} detail="Needs review" tone="red" />
      </div>

      {error && (
        <div className="alert-error" role="alert">
          {error}
        </div>
      )}

      <div className="table-shell">
        <table className="data-table mobile-card-table md:min-w-[52rem]">
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
                  <AdminEmptyState>No password reset requests yet.</AdminEmptyState>
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
      <td data-label="Email" className="break-all text-slate-600">{request.profiles.email ?? '—'}</td>
      <td data-label="Full Name" className="font-medium text-slate-900">{request.profiles.full_name}</td>
      <td data-label="Role" className="text-slate-600">{ROLE_LABEL[request.profiles.role]}</td>
      <td data-label="Requested" className="text-slate-500">{formatDateTime(request.requested_at)}</td>
      <td data-label="Status">
        <StatusBadge tone={STATUS_TONE[request.status]}>{statusLabel}</StatusBadge>
      </td>
      <td data-label="Completed" className="text-slate-500">
        {request.completed_at ? formatDateTime(request.completed_at) : '—'}
      </td>
    </tr>
  )
}
