import { DashboardLayout } from '../../components/DashboardLayout'
import { QueueBoard } from '../../components/QueueBoard'
import { AnnouncementsFeed } from '../../components/AnnouncementsFeed'

export function StaffDashboard() {
  return (
    <DashboardLayout title="Healthcare Staff Dashboard">
      <QueueBoard />
      <AnnouncementsFeed />
    </DashboardLayout>
  )
}
