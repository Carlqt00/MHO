import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AdminEmptyState,
  AdminPageHeader,
  AdminStatCard,
  StatusBadge,
} from '../../components/AdminPrimitives'
import {
  fetchNotificationLogs,
  fetchNotificationSummary,
  getSmsConversation,
  getSmsInbox,
  getUnreadSmsCount,
  markSmsMessageRead,
  sendManualSms,
  type NotificationLog,
  type NotificationStatus,
  type NotificationSummary,
  type SmsConversationMessage,
  type SmsInboxMessage,
} from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { toCanonicalPhilippineMobile } from '../../lib/phone'

type Filter = NotificationStatus | 'all'
type Tab = 'log' | 'inbox'

const SMS_CHAR_LIMIT = 480

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'sent', label: 'Sent' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' },
]

const SUMMARY_CARDS: { key: keyof NotificationSummary; label: string; detail: string; tone: 'emerald' | 'amber' | 'red' }[] = [
  { key: 'sent', label: 'Sent', detail: 'Accepted or delivered', tone: 'emerald' },
  { key: 'pending', label: 'Pending', detail: 'Awaiting gateway result', tone: 'amber' },
  { key: 'failed', label: 'Failed', detail: 'Needs review', tone: 'red' },
]

const STATUS_TONE: Record<NotificationStatus, 'emerald' | 'amber' | 'red'> = {
  sent: 'emerald',
  delivered: 'emerald',
  pending: 'amber',
  failed: 'red',
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
  if (status === 'delivered') return 'Sent'
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
  const [conversationFor, setConversationFor] = useState<SmsInboxMessage | null>(null)
  const [conversationMessages, setConversationMessages] = useState<SmsConversationMessage[]>([])
  const [conversationLoading, setConversationLoading] = useState(false)
  const [replyMessage, setReplyMessage] = useState('')
  const [replyError, setReplyError] = useState('')
  const [replySending, setReplySending] = useState(false)

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
  const replyCharacters = useMemo(() => replyMessage.trim().length, [replyMessage])
  const conversationPhone = conversationFor ? toCanonicalPhilippineMobile(conversationFor.sender) : null

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

  const loadConversation = useCallback(async (phone: string) => {
    setConversationLoading(true)
    try {
      setConversationMessages(await getSmsConversation(phone))
      setReplyError('')
    } catch (err) {
      setReplyError(errorMessage(err, 'Could not load this SMS conversation.'))
    } finally {
      setConversationLoading(false)
    }
  }, [])

  const openConversation = (sms: SmsInboxMessage) => {
    setError('')
    setNotice('')
    setReplyError('')
    setReplyMessage('')
    setConversationMessages([])
    setConversationFor(sms)
    const phone = toCanonicalPhilippineMobile(sms.sender)
    if (phone) void loadConversation(phone)
    else setReplyError('This SMS does not have a valid Philippine mobile number to reply to.')
  }

  const closeConversation = () => {
    if (replySending) return
    setConversationFor(null)
    setConversationMessages([])
    setReplyMessage('')
    setReplyError('')
  }

  const submitReply = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!conversationFor) return

    setReplyError('')
    setError('')
    setNotice('')

    const phone = toCanonicalPhilippineMobile(conversationFor.sender)
    const trimmedMessage = replyMessage.trim()

    if (!phone) {
      setReplyError('This SMS does not have a valid Philippine mobile number to reply to.')
      return
    }
    if (!trimmedMessage) {
      setReplyError('Reply message is required.')
      return
    }
    if (trimmedMessage.length > SMS_CHAR_LIMIT) {
      setReplyError(`Reply is too long. Please keep it under ${SMS_CHAR_LIMIT} characters.`)
      return
    }

    setReplySending(true)
    try {
      let readUpdateFailed = false
      await sendManualSms({ recipient: phone, message: trimmedMessage })
      if (!conversationFor.is_read) {
        try {
          await markSmsMessageRead(conversationFor.id, true)
        } catch (err) {
          readUpdateFailed = true
          setError(errorMessage(err, 'SMS reply sent, but the message could not be marked as read.'))
        }
      }
      setNotice('SMS reply sent.')
      setConversationFor((current) => current ? { ...current, is_read: true } : current)
      setReplyMessage('')
      setLoading(true)
      setInboxLoading(true)
      await Promise.all([
        loadData({ clearError: !readUpdateFailed }),
        loadInbox({ clearError: !readUpdateFailed }),
        loadConversation(phone),
      ])
    } catch (err) {
      setReplyError(errorMessage(err, 'SMS reply could not be sent.'))
    } finally {
      setReplySending(false)
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
    if (trimmedMessage.length > SMS_CHAR_LIMIT) {
      setError(`Message is too long. Please keep it under ${SMS_CHAR_LIMIT} characters.`)
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
    <section className="space-y-6">
      <AdminPageHeader
        title="Notification Center"
        subtitle="Send SMS notifications and review outbound delivery attempts and patient replies."
      />

      {error && (
        <div className="alert-error" role="alert">
          {error}
        </div>
      )}

      {notice && (
        <div className="alert-success" role="status">
          {notice}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {SUMMARY_CARDS.map((card) => (
          <AdminStatCard
            key={card.key}
            label={card.label}
            value={loading ? <span className="text-slate-300">…</span> : summary[card.key]}
            detail={card.detail}
            tone={card.tone}
          />
        ))}
      </div>

      <form onSubmit={submit} className="card overflow-hidden">
        <div className="border-b border-emerald-100 bg-white px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="section-kicker">Send SMS</p>
            <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">Manual notification</h3>
            <p className="mt-1 text-sm text-slate-500">
              Messages are sent through the secure Supabase Edge Function using MHO Daraga branding.
            </p>
          </div>
          <button type="submit" disabled={sending} className="btn-primary w-full sm:w-auto">
            {sending ? 'Sending…' : 'Send SMS'}
          </button>
          </div>
        </div>

        <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(14rem,20rem)_1fr]">
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
            <span className="mt-1 block text-xs text-slate-400">{messageCharacters}/{SMS_CHAR_LIMIT}</span>
          </label>
        </div>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
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
              <AdminEmptyState>No notification logs found for this filter.</AdminEmptyState>
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
                          <StatusBadge tone={STATUS_TONE[log.status]}>
                            {statusLabel(log.status)}
                          </StatusBadge>
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
            <AdminEmptyState>No SMS replies received yet.</AdminEmptyState>
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
                          <StatusBadge tone={sms.is_read ? 'slate' : 'emerald'}>
                            {sms.is_read ? 'Read' : 'Unread'}
                          </StatusBadge>
                        </td>
                        <td data-label="Actions">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => void updateReadStatus(sms.id, !sms.is_read)}
                              className="btn-subtle min-h-8 px-3 py-1 text-xs"
                            >
                              {sms.is_read ? 'Mark as unread' : 'Mark as read'}
                            </button>
                            <button
                              type="button"
                              onClick={() => openConversation(sms)}
                              disabled={!toCanonicalPhilippineMobile(sms.sender)}
                              className="btn-primary min-h-8 px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                              title={
                                toCanonicalPhilippineMobile(sms.sender)
                                  ? 'Open SMS conversation'
                                  : 'Cannot reply: invalid sender number'
                              }
                            >
                              Open Conversation
                            </button>
                          </div>
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

      {conversationFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 p-3 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sms-conversation-title"
        >
          <form
            onSubmit={submitReply}
            className="card flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col p-4 shadow-xl shadow-emerald-950/15 sm:p-6"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 id="sms-conversation-title" className="font-semibold text-slate-900">
                  SMS Conversation
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Recipient:{' '}
                  <span className="font-medium text-slate-800">
                    {conversationPhone ?? conversationFor.sender}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={closeConversation}
                disabled={replySending}
                className="btn-subtle min-h-8 px-3 py-1 text-xs"
              >
                Close
              </button>
            </div>

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-xl border border-emerald-100 bg-slate-50 p-3">
              {conversationLoading ? (
                <p className="text-sm text-slate-400">Loading conversation…</p>
              ) : conversationMessages.length === 0 ? (
                <AdminEmptyState>No messages found for this phone number.</AdminEmptyState>
              ) : (
                <div className="space-y-3">
                  {conversationMessages.map((item) => {
                    const outbound = item.direction === 'outbound'
                    return (
                      <div
                        key={`${item.direction}-${item.id}`}
                        className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[85%] rounded-xl px-3 py-2 text-sm shadow-sm sm:max-w-[70%] ${
                            outbound
                              ? 'bg-emerald-700 text-white'
                              : 'border border-emerald-100 bg-white text-slate-700'
                          }`}
                        >
                          <p
                            className={`text-xs font-semibold ${
                              outbound ? 'text-emerald-50' : 'text-emerald-800'
                            }`}
                          >
                            {outbound ? 'MHO' : 'Patient'}
                          </p>
                          <p className="mt-1 whitespace-pre-line break-words">{item.message}</p>
                          <p
                            className={`mt-2 text-xs ${
                              outbound ? 'text-emerald-50/80' : 'text-slate-400'
                            }`}
                          >
                            {formatDateTime(item.created_at)}
                            {item.status ? ` · ${statusLabel(item.status)}` : ''}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {replyError && (
              <div className="alert-error mt-4" role="alert">
                {replyError}
              </div>
            )}

            <label className="mt-4 block">
              <span className="label">Reply message</span>
              <textarea
                value={replyMessage}
                onChange={(e) => setReplyMessage(e.target.value)}
                rows={5}
                maxLength={SMS_CHAR_LIMIT}
                className="form-control resize-y"
                placeholder="Type your reply."
                disabled={replySending}
              />
              <span className="mt-1 block text-xs text-slate-400">
                {replyCharacters}/{SMS_CHAR_LIMIT}
              </span>
            </label>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={closeConversation}
                disabled={replySending}
                className="btn-secondary"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={replySending || !conversationPhone || replyCharacters === 0}
                className="btn-primary"
              >
                {replySending ? 'Sending…' : 'Send Reply'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
