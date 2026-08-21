import type { ReactNode } from 'react'
import { QRCodeSVG } from 'qrcode.react'

// Shared queue-ticket display used by BOTH the booking confirmation screen
// (size="full") and the patient profile's Current Booking cards
// (size="compact"), so patients recognise them as the same artifact. The
// ticket number is always the visual anchor; size only scales it.
//
// Kept presentational: callers pass already-formatted strings and any footer
// (e.g. the confirmation screen's reminder + "Bumalik sa Dashboard" button)
// via children, so extracting this does not change the confirmation behaviour.
type TicketSize = 'full' | 'compact'

interface TicketCardProps {
  size?: TicketSize
  ticketNumber: string
  serviceName: string
  dateLabel: string
  providerName: string
  qrCode: string
  status?: ReactNode
  children?: ReactNode
}

const STYLES: Record<TicketSize, Record<string, string>> = {
  full: {
    card: 'rounded-2xl border-2 border-emerald-400 bg-white p-8 text-center shadow-sm',
    label: 'text-sm font-semibold uppercase tracking-widest text-emerald-600',
    number: 'mt-2 text-8xl font-bold text-gray-900',
    service: 'mt-4 text-lg font-medium text-gray-700',
    date: 'mt-1 text-gray-500',
    provider: 'mt-1 text-sm text-gray-400',
    qrWrap: 'mt-6 rounded-xl bg-gray-50 px-4 py-3',
  },
  compact: {
    card: 'rounded-xl border border-emerald-300 bg-white p-5 text-center',
    label: 'text-xs font-semibold uppercase tracking-widest text-emerald-600',
    number: 'mt-1 text-5xl font-bold text-gray-900',
    service: 'mt-3 text-base font-medium text-gray-700',
    date: 'mt-1 text-sm text-gray-500',
    provider: 'mt-0.5 text-xs text-gray-400',
    qrWrap: 'mt-4 rounded-xl bg-gray-50 px-4 py-3',
  },
}

const QR_PIXELS: Record<TicketSize, number> = { full: 176, compact: 128 }

// The QR encodes a full URL to the public status page so any phone camera can
// open it; the bare code is never encoded on its own.
function checkinUrl(code: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/checkin/${code}`
}

export function TicketCard({
  size = 'full',
  ticketNumber,
  serviceName,
  dateLabel,
  providerName,
  qrCode,
  status,
  children,
}: TicketCardProps) {
  const s = STYLES[size]
  return (
    <div className={s.card}>
      <p className={s.label}>Queue Ticket</p>
      <p className={s.number}>{ticketNumber}</p>
      <p className={s.service}>{serviceName}</p>
      <p className={s.date}>{dateLabel}</p>
      <p className={s.provider}>{providerName}</p>
      {status && <div className="mt-2 flex justify-center">{status}</div>}

      <div className={s.qrWrap}>
        <p className="text-center text-xs font-semibold uppercase tracking-wide text-gray-500">
          QR Check-in Code
        </p>
        <div className="mt-2 flex justify-center">
          <QRCodeSVG value={checkinUrl(qrCode)} size={QR_PIXELS[size]} />
        </div>
        {/* Text fallback for a phone that can't scan the image. */}
        <p className="mt-2 break-all text-center font-mono text-xs text-gray-600">{qrCode}</p>
        <p className="mt-2 text-center text-xs text-gray-500">
          I-scan para makita ang inyong queue status. Mag-check in pa rin sa reception pagdating.
        </p>
      </div>

      {children}
    </div>
  )
}
