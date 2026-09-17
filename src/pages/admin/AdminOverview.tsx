import { useEffect, useState } from 'react'
import { fetchAdminStats, type AdminStats } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { VolumeChart } from '../../components/VolumeChart'

const CARDS: { key: keyof AdminStats; label: string }[] = [
  { key: 'totalPatients', label: 'Total Patients' },
  { key: 'totalProviders', label: 'Total Providers' },
  { key: 'appointmentsToday', label: 'Appointments Today' },
  { key: 'ticketsWaitingToday', label: 'Tickets Waiting Today' },
]

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
    <section>
      <h2 className="section-title">Overview</h2>
      <p className="mt-1 muted">Today's snapshot of the MHO system.</p>

      {error && (
        <div className="alert-error mt-4" role="alert">
          {error}
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {CARDS.map((card) => (
          <div key={card.key} className="card card-pad">
            <p className="text-sm font-medium text-slate-500">{card.label}</p>
            <p className="mt-2 text-3xl font-bold text-slate-950">
              {loading ? <span className="text-slate-300">…</span> : (stats?.[card.key] ?? 0)}
            </p>
          </div>
        ))}
      </div>

      <VolumeChart />
    </section>
  )
}
