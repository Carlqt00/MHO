import { Link } from 'react-router-dom'

export function Landing() {
  return (
    <div className="min-h-screen bg-emerald-50">
      <header className="px-6 py-5">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <span className="text-lg font-bold text-emerald-800">MHO Daraga</span>
          <Link
            to="/login"
            className="rounded-lg px-4 py-2 text-base font-medium text-emerald-800 hover:bg-emerald-100"
          >
            Login
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12 text-center">
        <h1 className="text-4xl font-bold text-gray-900 sm:text-5xl">
          Magpa-appointment nang madali sa Daraga Health Office
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-xl text-gray-600">
          Hindi na kailangang pumila nang maaga. Mag-book ng appointment online, kunin ang inyong
          queue number, at pumunta sa health center sa tamang oras.
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Link
            to="/register"
            className="w-full rounded-xl bg-emerald-600 px-8 py-4 text-xl font-semibold text-white hover:bg-emerald-700 sm:w-auto"
          >
            Gumawa ng Account
          </Link>
          <Link
            to="/login"
            className="w-full rounded-xl border-2 border-emerald-600 px-8 py-4 text-xl font-semibold text-emerald-700 hover:bg-emerald-100 sm:w-auto"
          >
            May Account Na Ako
          </Link>
        </div>

        <div className="mx-auto mt-16 grid max-w-3xl gap-6 text-left sm:grid-cols-3">
          <div className="rounded-xl bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-gray-800">1. Mag-book</h2>
            <p className="mt-2 text-gray-600">
              Piliin ang serbisyo at oras na gusto ninyo — Immunization, Prenatal, Check-up, o
              Dental.
            </p>
          </div>
          <div className="rounded-xl bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-gray-800">2. Kunin ang ticket</h2>
            <p className="mt-2 text-gray-600">
              Makakatanggap kayo ng queue number at paalala bago ang inyong appointment.
            </p>
          </div>
          <div className="rounded-xl bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-gray-800">3. Pumunta sa MHO</h2>
            <p className="mt-2 text-gray-600">
              I-scan ang QR code pagdating para mag-check in. Hintayin ang inyong numero.
            </p>
          </div>
        </div>
      </main>

      <footer className="px-6 py-8 text-center text-gray-500">
        Daraga Municipal Health Office · San Roque, Daraga, Albay
      </footer>
    </div>
  )
}
