import { NavLink, Outlet } from 'react-router-dom'
import { useState } from 'react'
import { DashboardLayout } from './DashboardLayout'
import { useAuth } from '../hooks/useAuth'
import type { Role } from '../lib/auth'

// Sidebar sections. `end` marks the index route so it only highlights on an
// exact match (otherwise "/admin" stays active on every child route). `roles`
// mirrors each route's guard — Reports is the only section staff may see.
const SECTIONS: { to: string; label: string; icon: string; end?: boolean; roles: Role[] }[] = [
  { to: '/admin', label: 'Overview', icon: 'OV', end: true, roles: ['admin'] },
  { to: '/admin/users', label: 'Users & Roles', icon: 'UR', roles: ['admin'] },
  { to: '/admin/providers', label: 'Providers & Slots', icon: 'PS', roles: ['admin'] },
  { to: '/admin/announcements', label: 'Announcements', icon: 'AN', roles: ['admin'] },
  { to: '/admin/notifications', label: 'Notifications', icon: 'NT', roles: ['admin'] },
  { to: '/admin/reports', label: 'Reports', icon: 'RP', roles: ['admin', 'staff'] },
  { to: '/admin/queue', label: 'Live Queue', icon: 'LQ', roles: ['admin'] },
  { to: '/admin/password-resets', label: 'Password Resets', icon: 'PR', roles: ['admin'] },
]

export function AdminLayout() {
  const { session } = useAuth()
  const role = session?.role
  const sections = SECTIONS.filter((s) => role && s.roles.includes(role))
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <DashboardLayout title={role === 'admin' ? 'Administrator Dashboard' : 'Reports'} wide>
      <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-emerald-100 bg-white px-4 py-3 shadow-sm shadow-emerald-950/5 lg:hidden">
        <p className="text-sm font-semibold text-slate-700">Admin sections</p>
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          className="btn-secondary min-h-10 px-4 py-2"
          aria-expanded={menuOpen}
          aria-controls="admin-mobile-nav"
        >
          Menu
        </button>
      </div>

      {menuOpen && (
        <button
          type="button"
          aria-label="Close admin menu"
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-40 bg-slate-950/35 lg:hidden"
        />
      )}

      <div className="flex w-full min-w-0 flex-col gap-6 lg:flex-row">
        <nav
          id="admin-mobile-nav"
          aria-label="Admin sections"
          className={`fixed inset-y-0 left-0 z-50 w-[min(18rem,86vw)] overflow-y-auto border-r border-emerald-100 bg-white p-4 shadow-xl shadow-slate-950/20 transition-transform lg:sticky lg:top-24 lg:z-auto lg:max-h-[calc(100vh-7rem)] lg:w-60 lg:shrink-0 lg:translate-x-0 lg:overflow-visible lg:rounded-2xl lg:border lg:bg-white/80 lg:p-3 lg:shadow-sm lg:shadow-emerald-950/5 ${
            menuOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="mb-4 flex items-center justify-between gap-3 lg:hidden">
            <span className="font-semibold text-slate-900">Admin menu</span>
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              className="btn-subtle min-h-9 px-3 py-1"
            >
              Close
            </button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {sections.map((section) => (
              <li key={section.to}>
                <NavLink
                  to={section.to}
                  end={section.end}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                      isActive
                        ? 'bg-emerald-700 text-white shadow-sm shadow-emerald-900/20'
                        : 'text-slate-600 hover:bg-emerald-50 hover:text-emerald-800'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold ${
                          isActive ? 'bg-white/15 text-white' : 'bg-emerald-50 text-emerald-700'
                        }`}
                        aria-hidden="true"
                      >
                        {section.icon}
                      </span>
                      <span className="min-w-0 truncate">{section.label}</span>
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </DashboardLayout>
  )
}
