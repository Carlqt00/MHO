import { Link } from 'react-router-dom'
import { DashboardLayout } from '../../components/DashboardLayout'
import { QueueBoard } from '../../components/QueueBoard'
import { AnnouncementsFeed } from '../../components/AnnouncementsFeed'

export function StaffDashboard() {
  return (
    <DashboardLayout title="Healthcare Staff Dashboard">
      <div className="mb-4">
        <Link
          to="/admin/reports"
          className="inline-block rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
        >
          View Reports
        </Link>
      </div>
      <QueueBoard />
      <AnnouncementsFeed />
    </DashboardLayout>
  )
}
