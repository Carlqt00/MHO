import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import {
  fetchQueueTicketByQrToken,
  manilaDateKey,
  setAppointmentStatus,
  todayManilaDateKey,
  type ScannedQueueTicket,
} from '../lib/api'
import { errorMessage } from '../lib/errors'
import { StatusBadge } from './AdminPrimitives'

type ScannerStep = 'scanning' | 'detected' | 'success'
type BlockReason = { message: string; tone: 'error' | 'success' }

interface CameraDevice {
  id: string
  label: string
}

interface QrCheckinScannerProps {
  onClose: () => void
  onCheckedIn: () => void
}

function formatAppointment(iso: string) {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function extractToken(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const url = new URL(trimmed)
    const parts = url.pathname.split('/').filter(Boolean)
    const checkinIndex = parts.findIndex((part) => part.toLowerCase() === 'checkin')
    if (checkinIndex >= 0 && parts[checkinIndex + 1]) {
      return decodeURIComponent(parts[checkinIndex + 1])
    }
  } catch {
    // Not a URL; treat it as a possible raw token below.
  }

  if (trimmed.includes('/checkin/')) {
    const token = trimmed.split('/checkin/')[1]?.split(/[?#]/)[0]
    return token ? decodeURIComponent(token) : null
  }

  return /^[A-Za-z0-9_-]{8,}$/.test(trimmed) ? trimmed : null
}

function checkBlockReason(ticket: ScannedQueueTicket): BlockReason | null {
  const appointment = ticket.appointments
  const appointmentDay = manilaDateKey(appointment.appointment_at)
  const today = todayManilaDateKey()

  if (appointmentDay !== today) {
    return {
      message: `This appointment is scheduled for ${formatAppointment(appointment.appointment_at)}. Check-in will be available on the appointment date.`,
      tone: 'success',
    }
  }
  if (appointment.status === 'checked_in') return { message: 'Patient is already checked in.', tone: 'error' }
  if (appointment.status === 'cancelled') return { message: 'This appointment has been cancelled.', tone: 'error' }
  if (appointment.status === 'served') return { message: 'This appointment has already been completed.', tone: 'error' }
  if (appointment.status === 'no_show') return { message: 'This appointment was already marked as no-show.', tone: 'error' }
  if (appointment.status !== 'booked') return { message: 'This appointment cannot be checked in.', tone: 'error' }
  if (ticket.status === 'done') return { message: 'This queue ticket is already closed.', tone: 'error' }

  return null
}

export function QrCheckinScanner({ onClose, onCheckedIn }: QrCheckinScannerProps) {
  const id = useId().replace(/:/g, '')
  const readerId = `qr-reader-${id}`
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const acceptedRef = useRef(false)
  const mountedRef = useRef(false)
  const [devices, setDevices] = useState<CameraDevice[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [step, setStep] = useState<ScannerStep>('scanning')
  const [ticket, setTicket] = useState<ScannedQueueTicket | null>(null)
  const [scanError, setScanError] = useState('')
  const [cameraError, setCameraError] = useState('')
  const [checkingIn, setCheckingIn] = useState(false)

  const stopScanner = useCallback(async () => {
    const scanner = scannerRef.current
    if (!scanner) return
    try {
      if (scanner.isScanning) await scanner.stop()
      await scanner.clear()
    } catch {
      // The browser may already have stopped the stream; cleanup is best effort.
    } finally {
      scannerRef.current = null
    }
  }, [])

  const validateToken = useCallback(
    async (rawValue: string) => {
      const token = extractToken(rawValue)
      if (!token) {
        setScanError('QR code is invalid or not recognized.')
        acceptedRef.current = false
        return
      }

      await stopScanner()
      setScanError('')
      setCameraError('')

      try {
        const found = await fetchQueueTicketByQrToken(token)
        if (!found) {
          setScanError('QR code is invalid or not recognized.')
          setStep('detected')
          return
        }
        setTicket(found)
        setStep('detected')
      } catch (err) {
        setScanError(errorMessage(err, 'Unable to validate this QR code.'))
        setStep('detected')
      }
    },
    [stopScanner]
  )

  const startScanner = useCallback(
    async (deviceId?: string) => {
      await stopScanner()
      acceptedRef.current = false
      setCameraError('')
      setScanError('')

      const scanner = new Html5Qrcode(readerId, false)
      scannerRef.current = scanner

      try {
        await scanner.start(
          deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 260, height: 260 }, aspectRatio: 1.333 },
          (decodedText) => {
            if (acceptedRef.current) return
            acceptedRef.current = true
            void validateToken(decodedText)
          },
          () => {}
        )
      } catch (err) {
        scannerRef.current = null
        const message = errorMessage(err, 'Unable to start the selected camera.')
        if (/permission|denied|notallowed/i.test(message)) {
          setCameraError('Camera access was denied. Allow camera access in your browser settings and try again.')
        } else if (/notfound|no camera|devices? found/i.test(message)) {
          setCameraError('No camera was detected.')
        } else {
          setCameraError('Unable to start the selected camera.')
        }
      }
    },
    [readerId, stopScanner, validateToken]
  )

  const loadCameras = useCallback(async () => {
    try {
      const cameras = await Html5Qrcode.getCameras()
      const nextDevices = cameras.map((camera, index) => ({
        id: camera.id,
        label: camera.label || `Camera ${index + 1}`,
      }))
      setDevices(nextDevices)
      const preferred =
        nextDevices.find((camera) => /back|rear|environment/i.test(camera.label)) ?? nextDevices[0]
      if (preferred) {
        setSelectedDeviceId(preferred.id)
        await startScanner(preferred.id)
      } else {
        setCameraError('No camera was detected.')
      }
    } catch (err) {
      const message = errorMessage(err, 'Unable to start the selected camera.')
      if (/permission|denied|notallowed/i.test(message)) {
        setCameraError('Camera access was denied. Allow camera access in your browser settings and try again.')
      } else {
        setCameraError('Unable to start the selected camera.')
      }
    }
  }, [startScanner])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    acceptedRef.current = false
    const timer = window.setTimeout(() => {
      void loadCameras()
    }, 0)

    return () => {
      window.clearTimeout(timer)
      void stopScanner()
    }
  }, [loadCameras, stopScanner])

  const handleCameraChange = async (deviceId: string) => {
    setSelectedDeviceId(deviceId)
    setStep('scanning')
    setTicket(null)
    await startScanner(deviceId)
  }

  const handleScanAgain = async () => {
    setStep('scanning')
    setTicket(null)
    setScanError('')
    acceptedRef.current = false
    await startScanner(selectedDeviceId || devices[0]?.id)
  }

  const handleConfirm = async () => {
    if (!ticket) return
    const blockReason = checkBlockReason(ticket)
    if (blockReason) {
      setScanError(blockReason.message)
      return
    }

    setCheckingIn(true)
    setScanError('')
    try {
      await setAppointmentStatus(ticket.appointments.id, 'checked_in')
      if (!mountedRef.current) return
      setStep('success')
      onCheckedIn()
    } catch (err) {
      setScanError(errorMessage(err, 'Unable to check in this appointment.'))
    } finally {
      setCheckingIn(false)
    }
  }

  const blockReason = ticket ? checkBlockReason(ticket) : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-3 py-4">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-4 shadow-2xl shadow-slate-950/20 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="section-kicker">Scan Patient QR</p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
              Scan Patient QR
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Place the patient's QR code inside the camera frame.
            </p>
          </div>
          <button className="btn-subtle w-full sm:w-auto" onClick={onClose}>
            Cancel
          </button>
        </div>

        {step === 'scanning' && (
          <div className="mt-5 space-y-4">
            <div className="overflow-hidden rounded-2xl border border-emerald-100 bg-slate-950">
              <div id={readerId} className="min-h-[280px] w-full" />
            </div>

            {devices.length > 0 && (
              <label className="block text-sm font-medium text-slate-600">
                Camera
                <select
                  value={selectedDeviceId}
                  onChange={(event) => void handleCameraChange(event.target.value)}
                  className="input mt-1"
                >
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {cameraError && <div className="alert-error">{cameraError}</div>}
            {scanError && <div className="alert-error">{scanError}</div>}

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button className="btn-subtle" onClick={() => void stopScanner()}>
                Stop Camera
              </button>
              <button className="btn-subtle" onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {step !== 'scanning' && (
          <div className="mt-5 space-y-4">
            {step === 'success' && ticket ? (
              <div className="alert-success">
                Check-in successful. Ticket {ticket.ticket_number} is now checked in.
              </div>
            ) : (
              <p className="text-sm font-semibold text-emerald-700">QR Detected</p>
            )}

            {ticket ? (
              <div className="rounded-2xl border border-emerald-100 bg-emerald-50/40 p-4">
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <InfoRow label="Ticket" value={ticket.ticket_number} />
                  <InfoRow
                    label="Patient"
                    value={ticket.appointments.patients.profiles.full_name}
                  />
                  <InfoRow label="Service" value={ticket.appointments.services.name} />
                  <InfoRow label="Provider" value={ticket.appointments.providers.profiles.full_name} />
                  <InfoRow
                    label="Appointment"
                    value={formatAppointment(ticket.appointments.appointment_at)}
                  />
                  <div>
                    <dt className="text-slate-500">Status</dt>
                    <dd className="mt-1">
                      <StatusBadge tone={ticket.appointments.status === 'booked' ? 'emerald' : 'slate'}>
                        {ticket.appointments.status.replace(/_/g, ' ')}
                      </StatusBadge>
                    </dd>
                  </div>
                </dl>
              </div>
            ) : (
              <div className="empty-state">QR code is invalid or not recognized.</div>
            )}

            {(scanError || blockReason) && (
              <div className={scanError ? 'alert-error' : blockReason?.tone === 'success' ? 'alert-success' : 'alert-error'}>
                {scanError || blockReason?.message}
              </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              {step !== 'success' && ticket && !blockReason && (
                <button
                  className="btn-primary"
                  onClick={() => void handleConfirm()}
                  disabled={checkingIn}
                >
                  {checkingIn ? 'Checking in…' : 'Confirm Check In'}
                </button>
              )}
              <button className="btn-subtle" onClick={() => void handleScanAgain()}>
                Scan Again
              </button>
              <button className="btn-subtle" onClick={onClose}>
                {step === 'success' ? 'Close' : 'Cancel'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-1 break-words font-medium text-slate-900">{value}</dd>
    </div>
  )
}
