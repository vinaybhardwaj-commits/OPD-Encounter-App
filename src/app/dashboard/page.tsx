/**
 * /dashboard — OPD doctor's queue (home state).
 *
 * Design doc §4.1: four lanes ordered by what's actionable.
 *   1. Ready to resume (green)  — diagnostics back, doctor up next
 *   2. Waiting (white)          — patient hasn't been seen yet
 *   3. At diagnostics (amber)   — encounter paused, test pending
 *   4. Completed (dim gray)     — archive view for today
 *
 * Server component — reads `getQueueForDoctor()` directly. Click handlers:
 *   - Waiting card     → POSTs server action `startEncounter` which
 *                        creates the encounter row + redirects
 *   - Other cards      → plain link to /dashboard/encounters/[id]
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentDoctor } from '@/lib/auth';
import { getQueueForDoctor, type QueueCard } from '@/lib/queue';
import { startEncounter } from './actions';
import { PatientSearch } from '@/components/PatientSearch';

export const dynamic = 'force-dynamic';

function firstName(full: string): string {
  return (full.split(/\s+/)[0] || full).replace(/^Dr\.?\s+/i, '');
}

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

export default async function DashboardPage() {
  const session = await getCurrentDoctor();
  if (!session) redirect('/auth/login');

  const q = await getQueueForDoctor(session.email);
  if (!q) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-even-white-DEFAULT px-6">
        <div className="text-sm text-even-ink-500">
          Your doctor record isn&apos;t seeded yet. Ask V to add{' '}
          <span className="font-mono">{session.email}</span> to{' '}
          <span className="font-mono">doctors</span>.
        </div>
      </main>
    );
  }

  const total = q.completed.length + q.ready_to_resume.length + q.at_diagnostics.length + q.waiting.length;
  const seenSoFar = q.completed.length;
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });

  return (
    <main className="min-h-screen bg-even-white-DEFAULT">
      <header className="border-b border-even-ink-100 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <div
              aria-hidden
              className="h-7 w-7 rounded-full bg-even-blue ring-4 ring-even-blue-100"
            />
            <span className="text-xs font-medium uppercase tracking-[0.18em] text-even-navy">
              Even OPD · EHRC
            </span>
          </div>
          <div className="mx-6 flex-1">
            <PatientSearch />
          </div>
          <div className="flex items-center gap-6">
            <Link
              href="/dashboard/drugs"
              className="text-xs font-medium uppercase tracking-wider text-even-ink-500 hover:text-even-navy"
            >
              Drug search
            </Link>
            <Link
              href="/admin/demo-controls"
              className="text-xs font-medium uppercase tracking-wider text-even-ink-400 hover:text-even-pink-700"
              title="Demo controls (admin)"
            >
              Demo
            </Link>
            <form action="/api/auth/logout" method="POST">
              <button
                type="submit"
                className="text-xs font-medium uppercase tracking-wider text-even-ink-500 hover:text-even-navy"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
        <div className="mx-auto max-w-6xl px-6 pb-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-even-navy">
                Good day, Dr. {firstName(q.doctor.name)}
              </h1>
              <p className="text-xs text-even-ink-500">
                {today} · {seenSoFar} of {total} seen
              </p>
            </div>
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-even-ink-400">
              <Pill color="green" label={`${q.ready_to_resume.length} ready`} />
              <Pill color="navy" label={`${q.waiting.length} waiting`} />
              <Pill color="amber" label={`${q.at_diagnostics.length} diagnostics`} />
              <Pill color="ink" label={`${q.completed.length} done`} />
            </div>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl space-y-8 px-6 py-8">
        {q.ready_to_resume.length > 0 && (
          <Lane
            title="Ready to resume"
            subtitle="Diagnostics back. Tap to continue the encounter."
            tone="ready"
            cards={q.ready_to_resume}
          />
        )}

        <Lane
          title="Waiting"
          subtitle="Hasn't been seen yet today. Tap a card to start the encounter."
          tone="waiting"
          cards={q.waiting}
          startAction={startEncounter}
        />

        {q.at_diagnostics.length > 0 && (
          <Lane
            title="At diagnostics"
            subtitle="Encounter paused, test pending."
            tone="diagnostics"
            cards={q.at_diagnostics}
          />
        )}

        {q.completed.length > 0 && (
          <Lane
            title="Completed today"
            subtitle="Done. Click to review."
            tone="completed"
            cards={q.completed}
            dim
          />
        )}
      </section>
    </main>
  );
}

function Pill({
  color,
  label,
}: {
  color: 'green' | 'navy' | 'amber' | 'ink';
  label: string;
}) {
  // Even has no green; treat "ready" with a confident blue ring instead.
  const tone =
    color === 'green'
      ? 'bg-even-blue-50 text-even-blue-800 ring-1 ring-even-blue-200'
      : color === 'amber'
      ? 'bg-even-pink-50 text-even-pink-800 ring-1 ring-even-pink-200'
      : color === 'navy'
      ? 'bg-even-navy-50 text-even-navy ring-1 ring-even-navy-100'
      : 'bg-even-ink-100 text-even-ink-700 ring-1 ring-even-ink-200';
  return (
    <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${tone}`}>
      {label}
    </span>
  );
}

function Lane({
  title,
  subtitle,
  tone,
  cards,
  startAction,
  dim,
}: {
  title: string;
  subtitle: string;
  tone: 'ready' | 'waiting' | 'diagnostics' | 'completed';
  cards: QueueCard[];
  startAction?: (formData: FormData) => Promise<void>;
  dim?: boolean;
}) {
  if (cards.length === 0) {
    return (
      <div>
        <LaneHeader title={title} subtitle={subtitle} count={0} tone={tone} />
        <p className="mt-3 rounded-xl border border-dashed border-even-ink-200 bg-white p-4 text-center text-xs text-even-ink-400">
          Nothing here right now.
        </p>
      </div>
    );
  }

  return (
    <div className={dim ? 'opacity-70' : ''}>
      <LaneHeader title={title} subtitle={subtitle} count={cards.length} tone={tone} />
      <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) =>
          startAction && !c.encounter_id ? (
            <StartCard key={c.patient_id} card={c} action={startAction} tone={tone} />
          ) : (
            <ResumeCard key={c.patient_id} card={c} tone={tone} />
          ),
        )}
      </ul>
    </div>
  );
}

function LaneHeader({
  title,
  subtitle,
  count,
  tone,
}: {
  title: string;
  subtitle: string;
  count: number;
  tone: 'ready' | 'waiting' | 'diagnostics' | 'completed';
}) {
  const accent =
    tone === 'ready'
      ? 'text-even-blue-700'
      : tone === 'diagnostics'
      ? 'text-even-pink-700'
      : tone === 'completed'
      ? 'text-even-ink-400'
      : 'text-even-navy';
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="flex items-baseline gap-3">
        <h2 className={`text-sm font-semibold uppercase tracking-[0.14em] ${accent}`}>
          {title}
        </h2>
        <span className="rounded-full bg-even-ink-100 px-2 py-0.5 text-[10px] font-semibold text-even-ink-700">
          {count}
        </span>
      </div>
      <p className="text-xs text-even-ink-500">{subtitle}</p>
    </div>
  );
}

function cardSurface(tone: 'ready' | 'waiting' | 'diagnostics' | 'completed') {
  if (tone === 'ready')
    return 'border-even-blue-300 bg-white shadow-sm ring-2 ring-even-blue-100 hover:border-even-blue-400';
  if (tone === 'diagnostics')
    return 'border-even-pink-200 bg-white hover:border-even-pink-300';
  if (tone === 'completed')
    return 'border-even-ink-100 bg-white hover:border-even-ink-200';
  return 'border-even-ink-200 bg-white hover:border-even-navy-200';
}

function CardBody({ card, tone }: { card: QueueCard; tone: 'ready' | 'waiting' | 'diagnostics' | 'completed' }) {
  return (
    <div className="text-left">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm font-semibold text-even-navy">
          {card.name}
        </span>
        <span className="shrink-0 text-[11px] font-mono text-even-ink-400">
          {card.age_years}{card.sex}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-even-ink-500 font-mono">
        {card.mrn}
      </div>
      {card.chief_complaint_text && (
        <p className="mt-2 line-clamp-2 text-xs text-even-ink-600">
          {card.chief_complaint_text}
        </p>
      )}
      {card.pending_diagnostic_test && (
        <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-even-pink-100 px-2 py-0.5 text-[10px] font-medium text-even-pink-800">
          {tone === 'ready' ? '✓ ' : '⌛ '}
          {card.pending_diagnostic_test}
        </p>
      )}
      {card.completed_at && (
        <p className="mt-2 text-[10px] uppercase tracking-wider text-even-ink-400">
          Done · {fmtTime(card.completed_at)}
        </p>
      )}
      {card.encounter_number && (
        <p className="mt-2 text-[10px] font-mono text-even-ink-300">
          {card.encounter_number}
        </p>
      )}
    </div>
  );
}

function StartCard({
  card,
  action,
  tone,
}: {
  card: QueueCard;
  action: (formData: FormData) => Promise<void>;
  tone: 'ready' | 'waiting' | 'diagnostics' | 'completed';
}) {
  return (
    <li>
      <form action={action}>
        <input type="hidden" name="patient_id" value={card.patient_id} />
        <button
          type="submit"
          className={`block w-full rounded-xl border p-4 text-left transition ${cardSurface(tone)}`}
          aria-label={`Start encounter for ${card.name}`}
        >
          <CardBody card={card} tone={tone} />
        </button>
      </form>
    </li>
  );
}

function ResumeCard({
  card,
  tone,
}: {
  card: QueueCard;
  tone: 'ready' | 'waiting' | 'diagnostics' | 'completed';
}) {
  return (
    <li>
      <Link
        href={card.encounter_id ? `/dashboard/encounters/${card.encounter_id}` : '/dashboard'}
        className={`block rounded-xl border p-4 transition ${cardSurface(tone)}`}
      >
        <CardBody card={card} tone={tone} />
      </Link>
    </li>
  );
}
