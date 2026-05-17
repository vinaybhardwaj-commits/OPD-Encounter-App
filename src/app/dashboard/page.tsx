/**
 * /dashboard — first authenticated landing for a signed-in doctor.
 *
 * M0.4: placeholder. The queue, encounter list, and active encounter cards
 * arrive in Sprint 2. This page exists to (a) prove the cookie round-trip
 * works end-to-end and (b) give the magic-link callback somewhere to land.
 */
import { redirect } from 'next/navigation';
import { getCurrentDoctor } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const doctor = await getCurrentDoctor();
  if (!doctor) redirect('/auth/login');

  return (
    <main className="min-h-screen bg-even-white-DEFAULT">
      <header className="border-b border-even-ink-100 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div
              aria-hidden
              className="h-7 w-7 rounded-full bg-even-blue ring-4 ring-even-blue-100"
            />
            <span className="text-xs font-medium uppercase tracking-[0.18em] text-even-navy">
              Even OPD
            </span>
          </div>
          <form action="/api/auth/logout" method="POST">
            <button
              type="submit"
              className="text-xs font-medium uppercase tracking-wider text-even-ink-500 hover:text-even-navy"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <section className="mx-auto max-w-4xl px-6 py-12">
        <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-even-blue-700">
          Signed in
        </p>
        <h1 className="mb-2 text-3xl font-semibold tracking-tight text-even-navy">
          Welcome
        </h1>
        <p className="mb-8 text-sm text-even-ink-600">
          You are signed in as <span className="font-mono text-even-navy">{doctor.email}</span>.
        </p>

        <div className="rounded-xl border border-even-ink-200 bg-white p-6">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-even-ink-500">
            Sprint 0 · M0.4
          </p>
          <p className="text-sm text-even-ink-600">
            Auth shell is live. The patient queue, encounter screen, and
            prescription compose flow ship in Sprints 1–4.
          </p>
        </div>
      </section>
    </main>
  );
}
