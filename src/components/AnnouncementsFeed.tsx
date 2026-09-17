import { useEffect, useState } from 'react'
import { fetchPublishedAnnouncements, type Announcement } from '../lib/api'
import { errorMessage } from '../lib/errors'

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

// Public advisories feed. Shown on every role dashboard — patients, and the
// staff/providers patients ask about advisories. Body is plain text; newlines
// are preserved via whitespace-pre-line (no rich-text dependency).
export function AnnouncementsFeed() {
  const [items, setItems] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchPublishedAnnouncements()
      .then((data) => {
        setItems(data)
        setError('')
      })
      .catch((e: unknown) => setError(errorMessage(e, 'Failed to load announcements.')))
      .finally(() => setLoading(false))
  }, [])

  return (
    <section className="mt-8">
      <h2 className="mb-3 section-title">Announcements</h2>

      {error && (
        <div className="alert-error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-slate-400">Loading…</p>
      ) : items.length === 0 ? (
        <div className="empty-state">
          No announcements right now.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <article key={a.id} className="card card-pad">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-semibold text-slate-900">{a.title}</h3>
                <time className="shrink-0 text-xs text-slate-400">{formatDate(a.created_at)}</time>
              </div>
              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-600">{a.body}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
