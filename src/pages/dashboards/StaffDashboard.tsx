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
          className="btn-secondary"
        >
          View Reports
        </Link>
      </div>
      <QueueBoard />
      <AnnouncementsFeed />
    </DashboardLayout>
  )
}
