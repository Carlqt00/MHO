import { DashboardLayout } from '../../components/DashboardLayout'
import { DoctorSchedule } from '../../components/DoctorSchedule'
import { AnnouncementsFeed } from '../../components/AnnouncementsFeed'

export function DoctorDashboard() {
  return (
    <DashboardLayout title="Doctor Dashboard">
      <DoctorSchedule />
      <AnnouncementsFeed />
    </DashboardLayout>
  )
}
