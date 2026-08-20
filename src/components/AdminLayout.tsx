import { NavLink, Outlet } from 'react-router-dom'
import { DashboardLayout } from './DashboardLayout'

// Sidebar sections. `end` marks the index route so it only highlights on an
// exact match (otherwise "/admin" stays active on every child route).
const SECTIONS: { to: string; label: string; end?: boolean }[] = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/users', label: 'Users & Roles' },
  { to: '/admin/providers', label: 'Providers & Slots' },
  { to: '/admin/announcements', label: 'Announcements' },
  { to: '/admin/notifications', label: 'Notifications' },
  { to: '/admin/reports', label: 'Reports' },
  { to: '/admin/queue', label: 'Live Queue' },
]

export function AdminLayout() {
  return (
    <DashboardLayout title="Administrator Dashboard">
      <div className="flex flex-col gap-6 md:flex-row">
        {/* Horizontal scroll on phones, vertical sidebar on tablets/desktop */}
        <nav aria-label="Admin sections" className="md:w-52 md:shrink-0">
          <ul className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0">
            {SECTIONS.map((section) => (
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
