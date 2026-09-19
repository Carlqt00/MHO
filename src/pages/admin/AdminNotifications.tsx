import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchNotificationLogs,
  fetchNotificationSummary,
  getSmsInbox,
  getUnreadSmsCount,
  markSmsMessageRead,
  sendManualSms,
  type NotificationLog,
  type NotificationStatus,
  type NotificationSummary,
  type SmsInboxMessage,
} from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { toCanonicalPhilippineMobile } from '../../lib/phone'

type Filter = NotificationStatus | 'all'
type Tab = 'log' | 'inbox'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'sent', label: 'Sent' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' },
]

// "Sent" = accepted/transmitted by the gateway; "Delivered" = handset receipt
// confirmed by the iTextMo webhook.
const SUMMARY_CARDS: { key: keyof NotificationSummary; label: string; tone: string }[] = [
  { key: 'sent', label: 'Sent', tone: 'text-emerald-700' },
  { key: 'delivered', label: 'Delivered', tone: 'text-sky-700' },
  { key: 'pending', label: 'Pending', tone: 'text-amber-600' },
  { key: 'failed', label: 'Failed', tone: 'text-red-600' },
]

const STATUS_STYLES: Record<NotificationStatus, string> = {
  sent: 'bg-emerald-100 text-emerald-800',
  delivered: 'bg-sky-100 text-sky-800',
  pending: 'bg-amber-100 text-amber-800',
  failed: 'bg-red-100 text-red-700',
}

// notification_logs.event → short label for the table.
const EVENT_LABEL: Record<string, string> = {
  manual: 'Manual',
  announcement: 'Announcement',
  password_reset_code: 'Password reset',
  appointment_booked: 'Booked',
  appointment_cancelled: 'Cancelled',
  appointment_rescheduled: 'Rescheduled',
  appointment_checked_in: 'Checked in',
  appointment_served: 'Served',
  appointment_no_show: 'No-show',
  queue_now_serving: 'Now serving',
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusLabel(status: NotificationStatus) {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

export function AdminNotifications() {
  const [logs, setLogs] = useState<NotificationLog[]>([])
  const [inbox, setInbox] = useState<SmsInboxMessage[]>([])
  const [summary, setSummary] = useState<NotificationSummary>({
    sent: 0,
    delivered: 0,
    pending: 0,
    failed: 0,
  })
  const [unreadCount, setUnreadCount] = useState(0)
  const [filter, setFilter] = useState<Filter>('all')
  const [tab, setTab] = useState<Tab>('log')
  const [loading, setLoading] = useState(true)
  const [inboxLoading, setInboxLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [recipient, setRecipient] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)

  const readData = useCallback(
    () => Promise.all([fetchNotificationSummary(), fetchNotificationLogs(filter)]),
    [filter]
  )

  const readInbox = useCallback(
    () => Promise.all([getSmsInbox(), getUnreadSmsCount()]),
    []
  )

  const loadData = useCallback(async (options: { clearError?: boolean } = {}) => {
    try {
      const [nextSummary, nextLogs] = await readData()
      setSummary(nextSummary)
      setLogs(nextLogs)
      if (options.clearError) setError('')
    } catch (err) {
      setError(errorMessage(err, 'Failed to load notification data.'))
    } finally {
      setLoading(false)
    }
  }, [readData])

  const loadInbox = useCallback(async (options: { clearError?: boolean } = {}) => {
    try {
      const [nextInbox, nextUnreadCount] = await readInbox()
      setInbox(nextInbox)
      setUnreadCount(nextUnreadCount)
      if (options.clearError) setError('')
    } catch (err) {
      setError(errorMessage(err, 'Failed to load SMS inbox.'))
    } finally {
      setInboxLoading(false)
    }
  }, [readInbox])

  useEffect(() => {
    let active = true
    readData()
      .then(([nextSummary, nextLogs]) => {
        if (!active) return
        setSummary(nextSummary)
        setLogs(nextLogs)
        setError('')
      })
      .catch((err: unknown) => {
        if (!active) return
        setError(errorMessage(err, 'Failed to load notification data.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [readData])

  useEffect(() => {
    let active = true
    readInbox()
      .then(([nextInbox, nextUnreadCount]) => {
        if (!active) return
        setInbox(nextInbox)
        setUnreadCount(nextUnreadCount)
      })
      .catch((err: unknown) => {
        if (!active) return
        setError(errorMessage(err, 'Failed to load SMS inbox.'))
      })
      .finally(() => {
        if (active) setInboxLoading(false)
      })

    return () => {
      active = false
    }
  }, [readInbox])

  const messageCharacters = useMemo(() => message.trim().length, [message])

  const updateReadStatus = async (id: string, isRead: boolean) => {
    setError('')
    try {
      await markSmsMessageRead(id, isRead)
      setInboxLoading(true)
      await loadInbox({ clearError: true })
    } catch (err) {
      setError(errorMessage(err, 'Could not update the SMS message.'))
      setInboxLoading(false)
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setNotice('')

    const phone = toCanonicalPhilippineMobile(recipient)
    const trimmedMessage = message.trim()

    if (!phone) {
      setError('Enter a valid Philippine mobile number. Example: 917 123 4567')
      return
    }
    if (!trimmedMessage) {
      setError('Message is required.')
      return
    }
    if (trimmedMessage.length > 480) {
      setError('Message is too long. Please keep it under 480 characters.')
      return
    }

    setSending(true)
    try {
      await sendManualSms({ recipient: phone, message: trimmedMessage })
      setNotice('SMS notification sent.')
      setRecipient('')
      setMessage('')
      setLoading(true)
      await loadData({ clearError: true })
    } catch (err) {
      setError(errorMessage(err, 'SMS notification could not be sent.'))
      setLoading(true)
      await loadData()
    } finally {
      setSending(false)
    }
  }

  return (
    <section>
      <div>
        <h2 className="section-title">Notification Center</h2>
        <p className="mt-1 muted">
          Send SMS notifications and review sent, pending, and failed delivery attempts.
        </p>
      </div>

      {error && (
        <div className="alert-error mt-4" role="alert">
          {error}
        </div>
      )}

      {notice && (
        <div className="alert-success mt-4" role="status">
          {notice}
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {SUMMARY_CARDS.map((card) => (
          <div key={card.key} className="card card-pad">
            <p className="text-sm font-medium text-slate-500">{card.label}</p>
            <p className={`mt-2 text-3xl font-bold ${card.tone}`}>
              {loading ? <span className="text-slate-300">…</span> : summary[card.key]}
            </p>
          </div>
        ))}
      </div>

      <form onSubmit={submit} className="card card-pad mt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-900">Send SMS Notification</h3>
            <p className="mt-1 text-sm text-slate-500">
              Messages are sent through the secure Supabase Edge Function.
            </p>
          </div>
          <button type="submit" disabled={sending} className="btn-primary w-full sm:w-auto">
            {sending ? 'Sending…' : 'Send SMS'}
          </button>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(14rem,20rem)_1fr]">
          <label className="block">
            <span className="label">Recipient / phone number</span>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="0917 123 4567"
              inputMode="tel"
              className="form-control"
            />
          </label>
          <label className="block">
            <span className="label">Message</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Type the SMS message here."
              className="form-control resize-y"
            />
            <span className="mt-1 block text-xs text-slate-400">{messageCharacters}/480</span>
          </label>
        </div>
      </form>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-900">Notification Log</h3>
          <p className="mt-1 text-sm text-slate-500">
            Review outbound delivery attempts and inbound patient replies.
          </p>
        </div>
        <div className="flex flex-wrap rounded-xl border border-emerald-100 bg-white p-1 shadow-sm">
          {[
            ['log', 'Notification Log'],
            ['inbox', `SMS Inbox${unreadCount > 0 ? ` (${unreadCount})` : ''}`],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value as Tab)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                tab === value
                  ? 'bg-emerald-700 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-emerald-50 hover:text-emerald-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'log' && (
        <>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-500">Latest 100 delivery attempts.</p>
            <div className="flex flex-wrap rounded-xl border border-emerald-100 bg-white p-1 shadow-sm">
              {FILTERS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => {
                    setLoading(true)
                    setFilter(item.value)
                  }}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    filter === item.value
                      ? 'bg-emerald-700 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-emerald-50 hover:text-emerald-800'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4">
            {loading ? (
              <p className="text-slate-400">Loading…</p>
            ) : logs.length === 0 ? (
              <div className="empty-state">No notification logs found for this filter.</div>
            ) : (
              <div className="table-shell">
                <table className="data-table mobile-card-table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Event</th>
                      <th>Recipient</th>
                      <th>Message</th>
                      <th>Status</th>
                      <th>Date / Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log.id}>
                        <td data-label="Type" className="whitespace-nowrap uppercase text-slate-600">
                          {log.type}
                        </td>
                        <td data-label="Event" className="whitespace-nowrap text-slate-600">
                          {log.event ? (EVENT_LABEL[log.event] ?? log.event) : '—'}
                        </td>
                        <td data-label="Recipient" className="whitespace-nowrap font-medium text-slate-800">
                          {log.recipient}
                        </td>
                        <td data-label="Message" className="max-w-xl text-slate-600 sm:min-w-[16rem]">
                          <p className="line-clamp-3 whitespace-pre-line">{log.message}</p>
                          {log.error_message && (
                            <p className="mt-1 text-xs text-red-600">{log.error_message}</p>
                          )}
                        </td>
                        <td data-label="Status" className="whitespace-nowrap">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              STATUS_STYLES[log.status]
                            }`}
                          >
                            {statusLabel(log.status)}
                          </span>
                        </td>
                        <td data-label="Date / Time" className="whitespace-nowrap text-slate-500">
                          {formatDateTime(log.sent_at ?? log.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'inbox' && (
        <div className="mt-4">
          <div className="mb-4 flex justify-end">
            <button
              type="button"
              onClick={() => {
                setInboxLoading(true)
                void loadInbox({ clearError: true })
              }}
              className="btn-subtle min-h-9 px-3 py-1.5 text-sm"
            >
              Refresh Inbox
            </button>
          </div>

          {inboxLoading ? (
            <p className="text-slate-400">Loading SMS inbox…</p>
          ) : inbox.length === 0 ? (
            <div className="empty-state">No SMS replies received yet.</div>
          ) : (
            <div className="table-shell">
              <table className="data-table mobile-card-table">
                <thead>
                  <tr>
                    <th>Sender</th>
                    <th>Message</th>
                    <th>Received</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {inbox.map((sms) => {
                    const sender = toCanonicalPhilippineMobile(sms.sender) ?? sms.sender
                    return (
                      <tr key={sms.id}>
                        <td data-label="Sender" className="whitespace-nowrap font-medium text-slate-800">
                          {sender}
                        </td>
                        <td data-label="Message" className="max-w-xl text-slate-600 sm:min-w-[16rem]">
                          <p className="whitespace-pre-line">{sms.message}</p>
                        </td>
                        <td data-label="Received" className="whitespace-nowrap text-slate-500">
                          {formatDateTime(sms.received_at)}
                        </td>
                        <td data-label="Status" className="whitespace-nowrap">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              sms.is_read
                                ? 'bg-slate-100 text-slate-600'
                                : 'bg-emerald-100 text-emerald-800'
                            }`}
                          >
                            {sms.is_read ? 'Read' : 'Unread'}
                          </span>
                        </td>
                        <td data-label="Actions">
                          <button
                            type="button"
                            onClick={() => void updateReadStatus(sms.id, !sms.is_read)}
                            className="btn-subtle min-h-8 px-3 py-1 text-xs"
                          >
                            {sms.is_read ? 'Mark as unread' : 'Mark as read'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
