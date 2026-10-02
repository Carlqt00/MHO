import type { ReactNode } from 'react'
import { useAuth } from '../hooks/useAuth'

const ROLE_LABEL: Record<string, string> = {
  patient: 'Patient',
  doctor: 'Doctor',
  nurse: 'Nurse',
  staff: 'Healthcare Staff',
  admin: 'Administrator',
}

export function AdminPageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
}: {
  title: string
  subtitle: string
  actions?: ReactNode
  eyebrow?: string
}) {
  const { session } = useAuth()
  const roleLabel = eyebrow ?? (session ? ROLE_LABEL[session.role] ?? session.role : 'Administrator')

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="section-kicker">{roleLabel}</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">{title}</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">{subtitle}</p>
      </div>
      {actions && <div className="flex flex-col gap-2 sm:flex-row sm:items-center">{actions}</div>}
    </div>
  )
}

export function AdminStatCard({
  label,
  value,
  detail,
  tone = 'emerald',
}: {
  label: string
  value: ReactNode
  detail?: string
  tone?: 'emerald' | 'amber' | 'red' | 'slate' | 'sky' | 'indigo'
}) {
  const toneClass = {
    emerald: 'from-emerald-600 via-emerald-300 text-emerald-700 bg-emerald-50',
    amber: 'from-amber-500 via-amber-200 text-amber-700 bg-amber-50',
    red: 'from-red-500 via-red-200 text-red-700 bg-red-50',
    slate: 'from-slate-500 via-slate-200 text-slate-700 bg-slate-50',
    sky: 'from-sky-500 via-sky-200 text-sky-700 bg-sky-50',
    indigo: 'from-indigo-500 via-indigo-200 text-indigo-700 bg-indigo-50',
  }[tone]

  return (
    <div className="relative min-h-32 overflow-hidden rounded-2xl border border-emerald-100 bg-white p-5 shadow-sm shadow-emerald-950/5">
      <div className={`absolute inset-x-0 bottom-0 h-1 bg-gradient-to-r ${toneClass} to-transparent`} />
      <div className="absolute -right-8 -top-10 h-24 w-24 rounded-full bg-emerald-50" />
      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{value}</p>
        </div>
        <span className={`h-10 w-10 shrink-0 rounded-xl border border-emerald-100 ${toneClass}`} />
      </div>
      {detail && <p className="relative mt-3 text-xs font-medium text-slate-400">{detail}</p>}
    </div>
  )
}

export function StatusBadge({
  children,
  tone = 'slate',
}: {
  children: ReactNode
  tone?: 'emerald' | 'amber' | 'red' | 'slate' | 'sky' | 'indigo' | 'orange'
}) {
  const cls = {
    emerald: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-700',
    slate: 'bg-slate-100 text-slate-600',
    sky: 'bg-sky-100 text-sky-800',
    indigo: 'bg-indigo-100 text-indigo-800',
    orange: 'bg-orange-100 text-orange-700',
  }[tone]

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {children}
    </span>
  )
}

export function AdminEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-emerald-200 bg-white/80 p-8 text-center text-sm text-slate-500 shadow-sm shadow-emerald-950/5">
      <div className="mx-auto mb-3 h-10 w-10 rounded-2xl border border-emerald-100 bg-emerald-50" />
      {children}
    </div>
  )
}
