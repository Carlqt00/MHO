import type { Role } from './auth'

export const DASHBOARD_PATH: Record<Role, string> = {
  patient: '/patient',
  doctor: '/doctor',
  nurse: '/nurse',
  staff: '/staff',
  admin: '/admin',
}
