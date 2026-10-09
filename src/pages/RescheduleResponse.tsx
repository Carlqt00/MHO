import { useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  fetchPublicRescheduleProposal,
  fetchPublicRescheduleProposalByCode,
  respondToRescheduleProposal,
  respondToRescheduleProposalByCode,
  type PublicRescheduleProposal,
} from '../lib/api'

function formatSlot(iso: string) {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function answeredText(status: string) {
  if (status === 'accepted') return 'This reschedule request has already been answered.'
  if (status === 'declined') return 'This reschedule request has already been answered.'
  if (status === 'expired') return 'This reschedule request has expired. Please contact MHO Daraga.'
  return 'This reschedule request is no longer available.'
}

export function RescheduleResponse() {
  const { token = '' } = useParams()
  const isTokenFlow = Boolean(token)
  const [code, setCode] = useState('')
  const [verifiedCode, setVerifiedCode] = useState('')
  const [proposal, setProposal] = useState<PublicRescheduleProposal | null>(null)
  const [loading, setLoading] = useState(isTokenFlow)
  const [submitting, setSubmitting] = useState<'accepted' | 'declined' | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState<'accepted' | 'declined' | null>(null)

  useEffect(() => {
    if (!isTokenFlow) {
      return
    }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const row = await fetchPublicRescheduleProposal(token)
        if (!cancelled) setProposal(row)
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message || 'This reschedule request could not be loaded.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [isTokenFlow, token])

  const normalizedCode = code.toUpperCase().replace(/[^A-Z2-9]/g, '')

  const lookupCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (normalizedCode.length < 8) {
      setError('Enter the 8-character confirmation code from your SMS.')
      return
    }
    setLoading(true)
    setError('')
    setProposal(null)
    setDone(null)
    try {
      const row = await fetchPublicRescheduleProposalByCode(normalizedCode)
      setProposal(row)
      setVerifiedCode(normalizedCode)
    } catch (e) {
      const message = (e as Error).message
      if (message === 'rate_limited') {
        setError('Too many attempts. Please wait a few minutes before trying again.')
      } else if (message === 'invalid_or_unavailable' || message === 'not_found') {
        setError('This reschedule request has already been answered or the code is no longer valid.')
      } else {
        setError(
          message || 'This reschedule request has already been answered or the code is no longer valid.'
        )
      }
    } finally {
      setLoading(false)
    }
  }

  const respond = async (response: 'accepted' | 'declined') => {
    if (
      response === 'declined' &&
      !confirm('Are you sure you want to decline this proposed schedule?')
    ) {
      return
    }
    setSubmitting(response)
    setError('')
    try {
      if (isTokenFlow) {
        await respondToRescheduleProposal(token, response)
      } else {
        await respondToRescheduleProposalByCode(verifiedCode, response)
      }
      setDone(response)
      if (!isTokenFlow) {
        setProposal(null)
        setVerifiedCode('')
      }
    } catch (e) {
      const message = (e as Error).message
      if (message === 'already_answered') {
        setError('This reschedule request has already been answered.')
      } else if (message === 'expired') {
        setError('This reschedule request has expired. Please contact MHO Daraga.')
      } else if (message === 'rate_limited') {
        setError('Too many attempts. Please wait a few minutes before trying again.')
      } else {
        setError(message || 'Could not record your response.')
      }
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-emerald-50 to-white px-4 py-8">
      <section className="mx-auto max-w-xl">
        <div className="mb-5">
          <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
            MHO Daraga
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">
            {isTokenFlow ? 'Appointment Reschedule Request' : 'Respond to Reschedule'}
          </h1>
        </div>

        <div className="card card-pad">
          {loading ? (
            <p className="text-slate-500">Loading request…</p>
          ) : !isTokenFlow && !proposal && !done ? (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">Confirmation Code</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Enter the code from your MHO Daraga reschedule SMS.
                </p>
              </div>
              {error && (
                <Result
                  title={error}
                  detail="Please check the code and try again, or contact MHO Daraga for assistance."
                  tone="warn"
                />
              )}
              <form onSubmit={lookupCode} className="space-y-3">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Confirmation Code
                  <input
                    value={code}
                    onChange={(event) => setCode(event.target.value.toUpperCase())}
                    inputMode="text"
                    autoComplete="one-time-code"
                    maxLength={11}
                    className="form-control mt-1 text-center text-lg font-semibold tracking-[0.25em]"
                    placeholder="K7M4Q9P2"
                  />
                </label>
                <button type="submit" className="btn-primary w-full sm:w-auto">
                  Continue
                </button>
              </form>
            </div>
          ) : done === 'accepted' ? (
            <Result
              title="Your appointment has been successfully rescheduled."
              detail="Thank you for confirming your new schedule."
            />
          ) : done === 'declined' ? (
            <Result
              title="You declined the proposed schedule."
              detail="Your affected appointment has been cancelled. Please contact MHO Daraga if you would like to create another appointment."
            />
          ) : error ? (
            <Result title={error} detail="For assistance, please contact MHO Daraga." tone="warn" />
          ) : !proposal ? (
            <Result title="Reschedule request not found." tone="warn" />
          ) : proposal.effective_status !== 'pending' ? (
            <Result title={answeredText(proposal.effective_status)} tone="warn" />
          ) : (
            <div className="space-y-5">
              <p className="alert-warn text-sm">
                Please review the proposed schedule before responding.
              </p>

              <dl className="grid gap-3 text-sm">
                <InfoRow label="Service" value={proposal.service_name} />
                <InfoRow label="Provider" value={proposal.provider_name} />
                <InfoRow
                  label="Original Schedule"
                  value={formatSlot(proposal.original_appointment_at)}
                />
                <InfoRow
                  label="Proposed New Schedule"
                  value={formatSlot(proposal.proposed_appointment_at)}
                />
                <InfoRow label="Reason" value={proposal.reason} />
              </dl>

              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => respond('accepted')}
                  disabled={!!submitting}
                  className="btn-primary"
                >
                  {submitting === 'accepted' ? 'Confirming…' : 'Agree to New Schedule'}
                </button>
                <button
                  type="button"
                  onClick={() => respond('declined')}
                  disabled={!!submitting}
                  className="btn-danger"
                >
                  {submitting === 'declined' ? 'Declining…' : 'Disagree'}
                </button>
              </div>
            </div>
          )}
        </div>

        <Link to="/" className="mt-5 inline-flex text-sm font-medium text-emerald-700">
          Back to MHO Daraga
        </Link>
      </section>
    </main>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-1 break-words font-medium text-slate-900">{value}</dd>
    </div>
  )
}

function Result({
  title,
  detail,
  tone = 'success',
}: {
  title: string
  detail?: string
  tone?: 'success' | 'warn'
}) {
  return (
    <div className={tone === 'success' ? 'alert-success' : 'alert-warn'}>
      <p className="font-semibold">{title}</p>
      {detail && <p className="mt-1 text-sm">{detail}</p>}
    </div>
  )
}
