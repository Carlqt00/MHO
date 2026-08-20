import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import {
  fetchAllAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  setAnnouncementPublished,
  deleteAnnouncement,
  type Announcement,
} from '../../lib/api'
import { errorMessage } from '../../lib/errors'

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none'

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function AdminAnnouncements() {
  const { session } = useAuth()
  const [items, setItems] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const fetchItems = useCallback(
    () =>
      fetchAllAnnouncements()
        .then((data) => {
          setItems(data)
          setError('')
        })
        .catch((e: unknown) => setError(errorMessage(e, 'Failed to load announcements.')))
        .finally(() => setLoading(false)),
    []
  )

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  const reload = useCallback(() => {
    setLoading(true)
    fetchItems()
  }, [fetchItems])

  const togglePublish = async (a: Announcement) => {
    setBusyId(a.id)
    setError('')
    try {
      await setAnnouncementPublished(a.id, !a.published)
    } catch (e) {
      setError(errorMessage(e, 'Could not update the announcement.'))
    } finally {
      setBusyId(null)
      reload()
    }
  }

  const remove = async (id: string) => {
    setBusyId(id)
    setError('')
    try {
      await deleteAnnouncement(id)
      setConfirmDelete(null)
    } catch (e) {
      setError(errorMessage(e, 'Could not delete the announcement.'))
    } finally {
      setBusyId(null)
      reload()
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Announcements</h2>
          <p className="mt-1 text-sm text-gray-500">
            Post advisories shown on every dashboard. Drafts stay private until published.
          </p>
        </div>
        <button
          onClick={() => setEditing('new')}
          disabled={editing !== null}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
        >
          + New announcement
        </button>
      </div>

      {editing && (
        <AnnouncementForm
          initial={editing === 'new' ? null : editing}
          postedBy={session?.userId}
          onDone={() => {
            setEditing(null)
            reload()
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {error && (
        <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}

      <div className="mt-6 space-y-3">
        {loading ? (
          <p className="text-gray-400">Loading…</p>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
            No announcements yet. Click "New announcement" to post the first advisory.
          </div>
        ) : (
          items.map((a) => (
            <div key={a.id} className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-gray-800">{a.title}</h3>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        a.published ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {a.published ? 'Published' : 'Draft'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-400">{formatDate(a.created_at)}</p>
                  <p className="mt-2 whitespace-pre-line text-sm text-gray-600">{a.body}</p>
                </div>

                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    onClick={() => togglePublish(a)}
                    disabled={busyId === a.id || editing !== null}
                    className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                  >
                    {a.published ? 'Unpublish' : 'Publish'}
                  </button>
                  <button
                    onClick={() => setEditing(a)}
                    disabled={busyId === a.id || editing !== null}
                    className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                  >
                    Edit
                  </button>
                  {confirmDelete === a.id ? (
                    <span className="inline-flex items-center gap-1">
                      <button
                        onClick={() => remove(a.id)}
                        disabled={busyId === a.id}
                        className="rounded-md bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-40"
                      >
                        {busyId === a.id ? 'Deleting…' : 'Confirm delete'}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(a.id)}
                      disabled={busyId === a.id || editing !== null}
                      className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function AnnouncementForm({
  initial,
  postedBy,
  onDone,
  onCancel,
}: {
  initial: Announcement | null
  postedBy?: string
  onDone: () => void
  onCancel: () => void
}) {
  const isEdit = initial !== null
  const [title, setTitle] = useState(initial?.title ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [publishNow, setPublishNow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !body.trim()) {
      setError('Title and body are both required.')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (isEdit) {
        await updateAnnouncement(initial.id, { title, body })
      } else {
        await createAnnouncement({ title, body, published: publishNow, postedBy })
      }
      onDone()
    } catch (err) {
      setError(errorMessage(err, 'Could not save the announcement.'))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 rounded-xl border border-gray-200 bg-white p-5">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-gray-700">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
      </label>
      <label className="mt-4 block">
        <span className="mb-1 block text-sm font-medium text-gray-700">Body</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder="Plain text. Line breaks are preserved."
          className={`${inputCls} resize-y`}
        />
      </label>

      {!isEdit && (
        <label className="mt-4 flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={publishNow}
            onChange={(e) => setPublishNow(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          Publish immediately (otherwise saved as a draft)
        </label>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4 flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
