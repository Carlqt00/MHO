import { NavLink, Outlet } from 'react-router-dom'
import { useState } from 'react'
import { DashboardLayout } from './DashboardLayout'
import { useAuth } from '../hooks/useAuth'
import type { Role } from '../lib/auth'

// Sidebar sections. `end` marks the index route so it only highlights on an
// exact match (otherwise "/admin" stays active on every child route). `roles`
// mirrors each route's guard — Reports is the only section staff may see.
const SECTIONS: { to: string; label: string; end?: boolean; roles: Role[] }[] = [
  { to: '/admin', label: 'Overview', end: true, roles: ['admin'] },
  { to: '/admin/users', label: 'Users & Roles', roles: ['admin'] },
  { to: '/admin/providers', label: 'Providers & Slots', roles: ['admin'] },
  { to: '/admin/announcements', label: 'Announcements', roles: ['admin'] },
  { to: '/admin/notifications', label: 'Notifications', roles: ['admin'] },
  { to: '/admin/reports', label: 'Reports', roles: ['admin', 'staff'] },
  { to: '/admin/queue', label: 'Live Queue', roles: ['admin'] },
  { to: '/admin/password-resets', label: 'Password Resets', roles: ['admin'] },
]

export function AdminLayout() {
  const { session } = useAuth()
  const role = session?.role
  const sections = SECTIONS.filter((s) => role && s.roles.includes(role))
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <DashboardLayout title={role === 'admin' ? 'Administrator Dashboard' : 'Reports'} wide>
      <div className="mb-4 flex items-center justify-between gap-3 lg:hidden">
        <p className="text-sm font-medium text-slate-600">Admin sections</p>
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          className="btn-secondary min-h-10 px-4 py-2"
          aria-expanded={menuOpen}
          aria-controls="admin-mobile-nav"
        >
          ☰ Menu
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
          className={`fixed inset-y-0 left-0 z-50 w-[min(19rem,86vw)] overflow-y-auto border-r border-emerald-100 bg-white p-4 shadow-xl shadow-slate-950/20 transition-transform lg:static lg:z-auto lg:w-56 lg:shrink-0 lg:translate-x-0 lg:overflow-visible lg:border-r-0 lg:bg-transparent lg:p-0 lg:shadow-none ${
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
          <ul className="flex flex-col gap-1">
            {sections.map((section) => (
              <li key={section.to}>
                <NavLink
                  to={section.to}
                  end={section.end}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) =>
                    `block rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-emerald-700 text-white shadow-sm shadow-emerald-900/20'
                        : 'text-slate-600 hover:bg-white hover:text-emerald-800'
                    }`
                  }
                >
                  {section.label}
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
