import { DashboardLayout, ComingSoon } from '../../components/DashboardLayout'
import { AnnouncementsFeed } from '../../components/AnnouncementsFeed'

export function DoctorDashboard() {
  return (
    <DashboardLayout title="Doctor Dashboard">
      <ComingSoon
        capabilities={[
          'View your assigned appointment schedule',
          'Set and manage your own availability',
        ]}
      />
      <AnnouncementsFeed />
    </DashboardLayout>
  )
}
