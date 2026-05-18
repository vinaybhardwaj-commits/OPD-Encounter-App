/**
 * /dashboard — first authenticated landing for a signed-in doctor.
 *
 * Sprint 1: gains a navigation card to /dashboard/drugs so V can
 * exercise the typeahead. The queue + encounter cards arrive in
 * Sprint 2; for now this is a routing hub.
 */
import Link from 'next/link';
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
        <p className="mb-10 text-sm text-even-ink-600">
          You are signed in as{' '}
          <span className="font-mono text-even-navy">{doctor.email}</span>.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/dashboard/drugs"
            className="group rounded-xl border border-even-ink-200 bg-white p-6 transition hover:border-even-blue-200 hover:shadow-sm"
          >
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-even-blue-700">
              Sprint 1 · M1.3
            </p>
            <h2 className="mb-1 text-lg font-semibold text-even-navy group-hover:text-even-blue-700">
              Drug typeahead →
            </h2>
            <p className="text-sm text-even-ink-600">
              Search 2,174 drugs by brand or generic. Sprint 4 drops this
              into the prescription compose row.
            </p>
          </Link>

          <div className="rounded-xl border border-dashed border-even-ink-200 bg-white p-6 opacity-60">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-even-ink-400">
              Sprint 2 · next
            </p>
            <h2 className="mb-1 text-lg font-semibold text-even-ink-500">
              Patient queue
            </h2>
            <p className="text-sm text-even-ink-500">
              Queue + encounter lifecycle ships in Sprint 2.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
