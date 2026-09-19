import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import {
  fetchAllAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  setAnnouncementPublished,
  deleteAnnouncement,
  countAnnouncementSmsRecipients,
  sendAnnouncementSms,
  type Announcement,
} from '../../lib/api'
import { errorMessage } from '../../lib/errors'

const inputCls =
  'form-control'

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
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
  // SMS broadcast: which announcement is on its confirm step, how many
  // patients it would reach, and the last run's outcome.
  const [confirmSms, setConfirmSms] = useState<string | null>(null)
  const [smsRecipients, setSmsRecipients] = useState<number | null>(null)
  const [smsNotice, setSmsNotice] = useState('')
  const [smsNoticeKind, setSmsNoticeKind] = useState<'success' | 'warn'>('success')

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

  // Step 1: show the recipient count and ask for confirmation. The gateway is
  // one SIM at ~1 msg/sec, so a broadcast is never a one-click action.
  const askSms = async (a: Announcement) => {
    setError('')
    setSmsNotice('')
    setSmsRecipients(null)
    setConfirmSms(a.id)
    try {
      setSmsRecipients(await countAnnouncementSmsRecipients())
    } catch (e) {
      setError(errorMessage(e, 'Could not count SMS recipients.'))
      setConfirmSms(null)
    }
  }

  // Step 2: fan out. The function reports sent / failed / skipped; skipped
  // means "not attempted this run" (time budget or cap) — run again to resume.
  const sendSms = async (a: Announcement) => {
    setBusyId(a.id)
    setError('')
    setSmsNotice('')
    try {
      const r = await sendAnnouncementSms(a.id)
      const parts = [`${r.sent} sent`]
      if (r.failed) parts.push(`${r.failed} failed`)
      if (r.skipped) parts.push(`${r.skipped} not yet attempted — click Send via SMS again to continue`)
      const already = r.total === 0 ? 'Every patient already received this announcement.' : ''
      setSmsNoticeKind(r.failed || r.skipped ? 'warn' : 'success')
      setSmsNotice(already || `SMS broadcast for “${a.title}”: ${parts.join(', ')}.`)
      setConfirmSms(null)
    } catch (e) {
      setError(errorMessage(e, 'Could not send the announcement by SMS.'))
    } finally {
      setBusyId(null)
      reload()
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="section-title">Announcements</h2>
          <p className="mt-1 muted">
            Post advisories shown on every dashboard. Drafts stay private until published.
          </p>
        </div>
        <button
          onClick={() => setEditing('new')}
          disabled={editing !== null}
          className="btn-primary"
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
        <div className="alert-error mt-4" role="alert">
          {error}
        </div>
      )}

      {smsNotice && (
        <div
          className={`${smsNoticeKind === 'warn' ? 'alert-warn' : 'alert-success'} mt-4`}
          role="status"
        >
          {smsNotice}
        </div>
      )}

      <div className="mt-6 space-y-3">
        {loading ? (
          <p className="text-slate-400">Loading…</p>
        ) : items.length === 0 ? (
          <div className="empty-state">
            No announcements yet. Click "New announcement" to post the first advisory.
          </div>
        ) : (
          items.map((a) => (
            <div key={a.id} className="card card-pad">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 break-words font-semibold text-slate-900">{a.title}</h3>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        a.published ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {a.published ? 'Published' : 'Draft'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    {formatDate(a.created_at)}
                    {a.sms_sent_at && (
                      <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800">
                        SMS sent {formatDateTime(a.sms_sent_at)}
                        {a.sms_recipient_count != null ? ` · ${a.sms_recipient_count} patients` : ''}
                      </span>
                    )}
                  </p>
                  <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-600">{a.body}</p>

                  {confirmSms === a.id && (
                    <div className="mt-3 rounded-2xl border border-sky-200 bg-sky-50 p-3 text-sm">
                      {smsRecipients === null ? (
                        <p className="text-sky-800">Counting recipients…</p>
                      ) : (
                        <>
                          <p className="font-semibold text-sky-900">
                            Text this announcement to {smsRecipients} patient
                            {smsRecipients === 1 ? '' : 's'}?
                          </p>
                          <p className="mt-1 text-xs text-sky-800">
                            One SMS per patient with a registered cellphone number. The gateway sends
                            about one message per second, so a large list takes a few minutes.
                            Patients who already received this announcement are skipped.
                            {a.sms_sent_at ? ' This announcement was already broadcast once.' : ''}
                          </p>
                          <div className="mt-2 flex gap-2">
                            <button
                              onClick={() => sendSms(a)}
                              disabled={busyId === a.id || smsRecipients === 0}
                              className="btn-primary min-h-8 px-3 py-1 text-xs"
                            >
                              {busyId === a.id ? 'Sending…' : 'Confirm & send'}
                            </button>
                            <button
                              onClick={() => setConfirmSms(null)}
                              disabled={busyId === a.id}
                              className="btn-subtle min-h-8 px-3 py-1 text-xs"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex w-full shrink-0 flex-wrap gap-2 sm:w-auto">
                  {a.published && (
                    <button
                      onClick={() => askSms(a)}
                      disabled={busyId === a.id || editing !== null || confirmSms === a.id}
                      className="btn-subtle min-h-8 px-3 py-1 text-xs"
                      title="Text this announcement to every patient"
                    >
                      Send via SMS
                    </button>
                  )}
                  <button
                    onClick={() => togglePublish(a)}
                    disabled={busyId === a.id || editing !== null}
                    className="btn-subtle min-h-8 px-3 py-1 text-xs"
                  >
                    {a.published ? 'Unpublish' : 'Publish'}
                  </button>
                  <button
                    onClick={() => setEditing(a)}
                    disabled={busyId === a.id || editing !== null}
                    className="btn-subtle min-h-8 px-3 py-1 text-xs"
                  >
                    Edit
                  </button>
                  {confirmDelete === a.id ? (
                    <span className="inline-flex flex-wrap items-center gap-1">
                      <button
                        onClick={() => remove(a.id)}
                        disabled={busyId === a.id}
                        className="btn-danger min-h-8 border-red-600 bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
                      >
                        {busyId === a.id ? 'Deleting…' : 'Confirm delete'}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="btn-subtle min-h-8 px-2 py-1 text-xs"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(a.id)}
                      disabled={busyId === a.id || editing !== null}
                      className="btn-danger min-h-8 px-3 py-1 text-xs"
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
    <form onSubmit={submit} className="card card-pad mt-4">
      <label className="block">
        <span className="label">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
      </label>
      <label className="mt-4 block">
        <span className="label">Body</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder="Plain text. Line breaks are preserved."
          className={`${inputCls} resize-y`}
        />
      </label>

      {!isEdit && (
        <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
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

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <button
          type="submit"
          disabled={busy}
          className="btn-primary"
        >
          {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="btn-secondary"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
