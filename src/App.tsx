import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './hooks/AuthProvider'
import { ProtectedRoute } from './components/ProtectedRoute'
import { Landing } from './pages/Landing'
import { Login } from './pages/Login'
import { Register } from './pages/Register'
import { Checkin } from './pages/Checkin'
import { PatientDashboard } from './pages/dashboards/PatientDashboard'
import { BookAppointment } from './pages/patient/BookAppointment'
import { PatientProfile } from './pages/patient/PatientProfile'
import { DoctorDashboard } from './pages/dashboards/DoctorDashboard'
import { NurseDashboard } from './pages/dashboards/NurseDashboard'
import { StaffDashboard } from './pages/dashboards/StaffDashboard'
import { AdminLayout } from './components/AdminLayout'
import { AdminOverview } from './pages/admin/AdminOverview'
import { AdminUsers } from './pages/admin/AdminUsers'
import { AdminProviders } from './pages/admin/AdminProviders'
import { AdminAnnouncements } from './pages/admin/AdminAnnouncements'
import { AdminNotifications } from './pages/admin/AdminNotifications'
import { AdminReports } from './pages/admin/AdminReports'
import { AdminQueue } from './pages/admin/AdminQueue'

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          {/* Public, no-login QR check-in status page */}
          <Route path="/checkin/:code" element={<Checkin />} />

          <Route
            path="/patient"
            element={
              <ProtectedRoute allow={['patient']}>
                <PatientDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/patient/book"
            element={
              <ProtectedRoute allow={['patient']}>
                <BookAppointment />
              </ProtectedRoute>
            }
          />
          <Route
            path="/patient/profile"
            element={
              <ProtectedRoute allow={['patient']}>
                <PatientProfile />
              </ProtectedRoute>
            }
          />
          <Route
            path="/doctor"
            element={
              <ProtectedRoute allow={['doctor']}>
                <DoctorDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/nurse"
            element={
              <ProtectedRoute allow={['nurse']}>
                <NurseDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/staff"
            element={
              <ProtectedRoute allow={['staff']}>
                <StaffDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute allow={['admin']}>
                <AdminLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<AdminOverview />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="providers" element={<AdminProviders />} />
            <Route path="announcements" element={<AdminAnnouncements />} />
            <Route path="notifications" element={<AdminNotifications />} />
            <Route path="reports" element={<AdminReports />} />
            <Route path="queue" element={<AdminQueue />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App
