import { DashboardLayout } from '../../components/DashboardLayout'
import { QueueBoard } from '../../components/QueueBoard'
import { AnnouncementsFeed } from '../../components/AnnouncementsFeed'

export function NurseDashboard() {
  return (
    <DashboardLayout title="Nurse Dashboard">
      <QueueBoard />
      <AnnouncementsFeed />
    </DashboardLayout>
  )
}
