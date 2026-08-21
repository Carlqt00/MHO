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
    <div className="min-h-screen bg-emerald-50">
      <header className="px-6 py-5">
        <div className="mx-auto max-w-md">
          <span className="text-lg font-bold text-emerald-800">MHO Daraga</span>
        </div>
      </header>

      <main className="mx-auto max-w-md px-6 py-8">
        <h1 className="mb-6 text-center text-2xl font-bold text-gray-900">Check-in Status</h1>

        {loading ? (
          <p className="text-center text-gray-400">Loading…</p>
        ) : error ? (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        ) : !status ? (
          // Unknown/invalid code — plain message, nothing about the code itself.
          <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
            <p className="text-lg font-medium">Hindi mahanap ang ticket.</p>
            <p className="mt-1 text-sm">Ticket not found.</p>
          </div>
        ) : (
          <div className="rounded-2xl border-2 border-emerald-400 bg-white p-8 text-center shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-widest text-emerald-600">
              Queue Ticket
            </p>
            <p className="mt-2 text-7xl font-bold text-gray-900">{status.ticket_number}</p>

            <div className="mt-4 inline-block rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">
              {TICKET_STATUS_LABEL[status.status] ?? status.status}
            </div>

            <dl className="mt-6 space-y-2 text-left text-sm">
              <Row label="Queue position" value={`#${status.queue_position}`} />
              <Row label="Serbisyo / Service" value={status.service_name} />
              <Row label="Provider" value={status.provider_name} />
              <Row label="Petsa at Oras" value={formatSlot(status.slot_datetime)} />
            </dl>

            <p className="mt-6 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
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
    <div className="flex justify-between gap-4">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-right font-medium text-gray-800">{value}</dd>
    </div>
  )
}
