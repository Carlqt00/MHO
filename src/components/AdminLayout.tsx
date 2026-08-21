import { NavLink, Outlet } from 'react-router-dom'
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
]

export function AdminLayout() {
  const { session } = useAuth()
  const role = session?.role
  const sections = SECTIONS.filter((s) => role && s.roles.includes(role))

  return (
    <DashboardLayout title={role === 'admin' ? 'Administrator Dashboard' : 'Reports'}>
      <div className="flex flex-col gap-6 md:flex-row">
        {/* Horizontal scroll on phones, vertical sidebar on tablets/desktop */}
        <nav aria-label="Admin sections" className="md:w-52 md:shrink-0">
          <ul className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0">
            {sections.map((section) => (
              <li key={section.to} className="shrink-0 md:shrink">
                <NavLink
                  to={section.to}
                  end={section.end}
                  className={({ isActive }) =>
                    `block whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-emerald-600 text-white'
                        : 'text-gray-600 hover:bg-gray-100'
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
