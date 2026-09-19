import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fetchCheckinStatus, type CheckinStatus } from '../lib/api'

function formatSlot(iso: string) {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// queue_tickets.status — not the appointment status.
const TICKET_STATUS_LABEL: Record<string, string> = {
  waiting: 'Naghihintay / Waiting',
  now_serving: 'Tinatawag na / Now serving',
  done: 'Tapos na / Done',
}

export function Checkin() {
  const { code } = useParams<{ code: string }>()
  const [status, setStatus] = useState<CheckinStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    // The route always supplies :code; an empty string is treated as an
    // unknown code by the RPC and renders the plain "not found" state.
    fetchCheckinStatus(code ?? '')
      .then((data) => {
        setStatus(data)
        setLoading(false)
      })
      .catch((e: Error) => {
        setError(e.message)
        setLoading(false)
      })
  }, [code])

  return (
    <div className="min-h-screen">
      <header className="px-3 py-5 sm:px-6">
        <div className="mx-auto max-w-md">
          <span className="brand-lockup min-w-0 text-base sm:text-lg">
            <span className="brand-mark h-10 w-10 sm:h-11 sm:w-11">MHO</span>
            <span>MHO Daraga</span>
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-md px-3 py-6 sm:px-6 sm:py-8">
        <h1 className="mb-6 text-center text-2xl font-bold text-slate-950">Check-in Status</h1>

        {loading ? (
          <p className="text-center text-slate-400">Loading…</p>
        ) : error ? (
          <div className="alert-error">{error}</div>
        ) : !status ? (
          // Unknown/invalid code — plain message, nothing about the code itself.
          <div className="empty-state">
            <p className="text-lg font-medium">Hindi mahanap ang ticket.</p>
            <p className="mt-1 text-sm">Ticket not found.</p>
          </div>
        ) : (
          <div className="card p-4 text-center sm:p-8">
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-600">
              Queue Ticket
            </p>
            <p className="mt-2 break-all text-[clamp(3rem,17vw,4.5rem)] font-bold leading-none text-slate-950">
              {status.ticket_number}
            </p>

            <div className="mt-4 inline-block rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">
              {TICKET_STATUS_LABEL[status.status] ?? status.status}
            </div>

            <dl className="mt-6 space-y-2 text-left text-sm">
              <Row label="Queue position" value={`#${status.queue_position}`} />
              <Row label="Serbisyo / Service" value={status.service_name} />
              <Row label="Provider" value={status.provider_name} />
              <Row label="Petsa at Oras" value={formatSlot(status.slot_datetime)} />
            </dl>

            <p className="alert-warn mt-6">
              Ang pahinang ito ay para tingnan lamang ang status — hindi ito nagche-check in sa
              inyo. Mangyaring mag-check in sa reception ng MHO pagdating. / This page is read-only
              and does not check you in — please check in at the MHO reception on arrival.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 min-[420px]:flex-row min-[420px]:justify-between min-[420px]:gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-words font-medium text-slate-900 min-[420px]:text-right">{value}</dd>
    </div>
  )
}
