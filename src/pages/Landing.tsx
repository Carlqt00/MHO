import { Link } from 'react-router-dom'

export function Landing() {
  return (
    <div className="landing-bg min-h-screen">
      <header className="page-shell py-5">
        <div className="content-shell flex items-center justify-between">
          <span className="brand-lockup text-lg">
            <img
              src="/daraga-municipality-seal.svg"
              alt="Municipality of Daraga seal"
              className="brand-seal"
            />
            <span>MHO Daraga</span>
          </span>
          <Link
            to="/login"
            className="btn-secondary"
          >
            Login
          </Link>
        </div>
      </header>

      <main className="page-shell pb-12 pt-8 sm:pt-14">
        <div className="content-shell">
          <section className="landing-panel mx-auto max-w-3xl text-center">
            <p className="section-kicker">Daraga Municipal Health Office</p>
            <h1 className="mx-auto mt-4 flex max-w-2xl flex-col items-center gap-1.5 text-center font-bold leading-[1.12] text-slate-950 sm:gap-2">
              <span className="block text-[clamp(1.625rem,4.25vw,2.5rem)]">
                MUNICIPAL HEALTH OFFICE
              </span>
              <span className="block max-w-full text-balance text-[clamp(1.375rem,3.5vw,2rem)]">
                CENTRALIZED APPOINTMENT AND TICKETING SYSTEM
              </span>
              <span className="block text-[clamp(1.625rem,4.25vw,2.5rem)]">
                IN DARAGA, ALBAY
              </span>
            </h1>

            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:mt-8 sm:flex-row">
              <Link to="/register" className="btn-primary w-full px-8 py-4 text-base sm:w-auto">
                Create Account
              </Link>
              <Link to="/login" className="btn-secondary w-full px-8 py-4 text-base sm:w-auto">
                I Already Have an Account
              </Link>
            </div>
          </section>

          <div className="mx-auto mt-10 grid max-w-5xl gap-4 text-left sm:grid-cols-3">
            {[
              ['01', 'Mag-book', 'Piliin ang serbisyo at oras na gusto ninyo: Immunization, Prenatal, Check-up, o Dental.'],
              ['02', 'Kunin ang ticket', 'Makakatanggap kayo ng queue number at paalala bago ang inyong appointment.'],
              ['03', 'Pumunta sa MHO', 'Pumunta sa MHO nang ilang minuto bago ang oras ng inyong appointment.'],
            ].map(([number, title, body]) => (
              <article key={title} className="card card-interactive card-pad">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-sm font-bold text-emerald-800">
                  {number}
                </span>
                <h2 className="mt-4 text-lg font-semibold text-slate-900">{title}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </main>

      <footer className="page-shell pb-8 text-center text-sm text-slate-500">
        Daraga Municipal Health Office · San Roque, Daraga, Albay
      </footer>
    </div>
  )
}
