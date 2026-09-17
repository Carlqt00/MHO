import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './hooks/AuthProvider'
import { ProtectedRoute } from './components/ProtectedRoute'
import { Landing } from './pages/Landing'
import { Login } from './pages/Login'
import { Register } from './pages/Register'
import { ForgotPassword } from './pages/ForgotPassword'
import { ResetPassword } from './pages/ResetPassword'
import { ChangePassword } from './pages/ChangePassword'
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
import { AdminPasswordResets } from './pages/admin/AdminPasswordResets'

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          {/* Public, no-login QR check-in status page */}
          <Route path="/checkin/:code" element={<Checkin />} />
          <Route
            path="/change-password"
            element={
              <ProtectedRoute allow={['patient', 'doctor', 'nurse', 'staff', 'admin']}>
                <ChangePassword />
              </ProtectedRoute>
            }
          />

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
          {/* Parent allows the UNION of roles that can see ANY admin child
              (admin + staff). Each child is then guarded individually — all
              admin-only EXCEPT Reports, which staff may also view. */}
          <Route
            path="/admin"
            element={
              <ProtectedRoute allow={['admin', 'staff']}>
                <AdminLayout />
              </ProtectedRoute>
            }
          >
            <Route
              index
              element={
                <ProtectedRoute allow={['admin']}>
                  <AdminOverview />
                </ProtectedRoute>
              }
            />
            <Route
              path="users"
              element={
                <ProtectedRoute allow={['admin']}>
                  <AdminUsers />
                </ProtectedRoute>
              }
            />
            <Route
              path="providers"
              element={
                <ProtectedRoute allow={['admin']}>
                  <AdminProviders />
                </ProtectedRoute>
              }
            />
            <Route
              path="announcements"
              element={
                <ProtectedRoute allow={['admin']}>
                  <AdminAnnouncements />
                </ProtectedRoute>
              }
            />
            <Route
              path="notifications"
              element={
                <ProtectedRoute allow={['admin']}>
                  <AdminNotifications />
                </ProtectedRoute>
              }
            />
            <Route
              path="reports"
              element={
                <ProtectedRoute allow={['admin', 'staff']}>
                  <AdminReports />
                </ProtectedRoute>
              }
            />
            <Route
              path="queue"
              element={
                <ProtectedRoute allow={['admin']}>
                  <AdminQueue />
                </ProtectedRoute>
              }
            />
            <Route
              path="password-resets"
              element={
                <ProtectedRoute allow={['admin']}>
                  <AdminPasswordResets />
                </ProtectedRoute>
              }
            />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App
