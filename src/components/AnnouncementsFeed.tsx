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
      <h2 className="mb-3 text-lg font-semibold text-gray-800">📢 Mga Anunsyo / Announcements</h2>

      {error && (
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-gray-400">Loading…</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center text-gray-500">
          Walang anunsyo sa ngayon. / No announcements right now.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((a) => (
            <article key={a.id} className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-semibold text-gray-800">{a.title}</h3>
                <time className="shrink-0 text-xs text-gray-400">{formatDate(a.created_at)}</time>
              </div>
              <p className="mt-2 whitespace-pre-line text-sm text-gray-600">{a.body}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
