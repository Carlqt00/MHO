import { useEffect, useState } from 'react'
import { fetchAdminStats, type AdminStats } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { VolumeChart } from '../../components/VolumeChart'

const CARDS: { key: keyof AdminStats; label: string; detail: string; icon: 'patients' | 'providers' | 'calendar' | 'ticket' }[] = [
  { key: 'totalPatients', label: 'Total Patients', detail: 'Registered patient records', icon: 'patients' },
  { key: 'totalProviders', label: 'Total Providers', detail: 'Active clinical providers', icon: 'providers' },
  { key: 'appointmentsToday', label: 'Appointments Today', detail: 'Scheduled for today', icon: 'calendar' },
  { key: 'ticketsWaitingToday', label: 'Tickets Waiting Today', detail: 'Currently in queue', icon: 'ticket' },
]

function SummaryIcon({ type }: { type: (typeof CARDS)[number]['icon'] }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
      {type === 'patients' && (
        <>
          <path {...common} d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
          <path {...common} d="M2.5 21a6.5 6.5 0 0 1 13 0" />
          <path {...common} d="M17 9.5a3 3 0 1 0 0-6" />
          <path {...common} d="M18.5 14.5A5.5 5.5 0 0 1 22 20" />
        </>
      )}
      {type === 'providers' && (
        <>
          <path {...common} d="M12 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" />
          <path {...common} d="M4 22a8 8 0 0 1 16 0" />
          <path {...common} d="M12 6.5v5" />
          <path {...common} d="M9.5 9h5" />
        </>
      )}
      {type === 'calendar' && (
        <>
          <path {...common} d="M7 3v3M17 3v3M4 9h16" />
          <path {...common} d="M5 5h14a1 1 0 0 1 1 1v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1Z" />
          <path {...common} d="m9 15 2 2 4-5" />
        </>
      )}
      {type === 'ticket' && (
        <>
          <path {...common} d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7Z" />
          <path {...common} d="M9 8h6M9 12h6M9 16h4" />
        </>
      )}
    </svg>
  )
}

export function AdminOverview() {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchAdminStats()
      .then((data) => {
        setStats(data)
        setError('')
      })
      .catch((e: unknown) => setError(errorMessage(e, 'Failed to load the overview stats.')))
      .finally(() => setLoading(false))
  }, [])

  return (
    <section className="space-y-7">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="section-kicker">Administrator</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">Overview</h2>
          <p className="mt-1 text-sm text-slate-500">
            Today's operational snapshot for MHO Daraga.
          </p>
        </div>
      </div>

      {error && (
        <div className="alert-error" role="alert">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {CARDS.map((card) => (
          <div key={card.key} className="group relative min-h-36 overflow-hidden rounded-2xl border border-emerald-100 bg-white p-5 shadow-sm shadow-emerald-950/5">
            <div className="absolute inset-x-0 bottom-0 h-1 bg-gradient-to-r from-emerald-600 via-emerald-300 to-transparent" />
            <div className="absolute -right-8 -top-10 h-28 w-28 rounded-full bg-emerald-50" />
            <div className="relative flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-slate-500">{card.label}</p>
                <p className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                  {loading ? <span className="text-slate-300">…</span> : (stats?.[card.key] ?? 0)}
                </p>
              </div>
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-100 bg-emerald-50 text-emerald-700 shadow-sm shadow-emerald-950/5">
                <SummaryIcon type={card.icon} />
              </span>
            </div>
            <p className="relative mt-4 text-xs font-medium text-slate-400">{card.detail}</p>
          </div>
        ))}
      </div>

      <VolumeChart stats={stats} />
    </section>
  )
}
