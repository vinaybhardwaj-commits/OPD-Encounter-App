/**
 * /patients/[id] — longitudinal patient view (PH.2).
 *
 * Server component. Read-only in PH.2 — editing flows ship in PH.5.
 *
 * Layout (PRD §5.1):
 *   1. Patient banner (name, age/sex, MRN, phone, allergy pill)
 *   2. Qwen summary card (AI dot, summary_text, computed-at, Recompute)
 *   3. Problem list (table) — PH.2.2
 *   4. Medication history (table) — PH.2.2
 *   5. Allergy + risk profile strip — PH.2.2
 *   6. Encounter timeline (reverse-chronological cards) — PH.2.2
 *
 * Auth: middleware (matcher extended to /patients/:path*) redirects
 * unauthenticated requests to /auth/login.
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { pool } from '@/lib/db';
import { getCurrentDoctor } from '@/lib/auth';
import { actionRecompute } from './actions';

export const dynamic = 'force-dynamic';
// Recompute server action calls Qwen (~5-47s warm/cold). 300s is the
// page-segment ceiling on Vercel Pro, well above any single call.
export const maxDuration = 300;

type Patient = {
  id: string;
  mrn: string;
  name: string;
  age_years: number;
  sex: 'M' | 'F' | 'O' | null;
  phone_e164: string | null;
  known_allergies: string | null;
};

type SummaryRow = {
  summary: ValidatedSummary | Record<string, unknown> | null;
  status: string;
  computed_at: string | null;
  qwen_model: string | null;
  qwen_latency_ms: number | null;
  source_encounter_count: number | null;
  source_window_start: string | null;
  source_window_end: string | null;
  fail_reason: string | null;
};

// Match the validator output, but accept partial fields so a stale row
// with a missing key doesn't crash the page.
type ValidatedSummary = {
  summary_text?: string;
  problem_list?: unknown[];
  medication_history?: unknown[];
  allergy_aggregation?: unknown[];
  cc_chip_rankings?: string[];
  cc_chip_additions?: string[];
  disposition_recommendation?: string;
  disposition_additions?: string[];
  red_flags?: { kind?: string; text?: string; severity?: string }[];
};

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'never';
  const diffMs = Date.now() - t;
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default async function PatientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getCurrentDoctor();
  if (!session) redirect('/auth/login');

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  // Load patient + cached summary in parallel.
  const [patientRows, summaryRows] = await Promise.all([
    pool.query<Patient>(
      `SELECT id, mrn, name, age_years, sex, phone_e164, known_allergies
         FROM patients WHERE id = $1 LIMIT 1`,
      [id],
    ),
    pool.query<SummaryRow>(
      `SELECT summary, status,
              computed_at::text AS computed_at,
              qwen_model, qwen_latency_ms,
              source_encounter_count,
              source_window_start::text AS source_window_start,
              source_window_end::text AS source_window_end,
              fail_reason
         FROM patient_summaries
        WHERE patient_id = $1 LIMIT 1`,
      [id],
    ),
  ]);

  const patient = patientRows.rows[0];
  if (!patient) notFound();
  const summaryRow = summaryRows.rows[0] ?? null;
  const summary = (summaryRow?.summary ?? null) as ValidatedSummary | null;

  return (
    <main className="min-h-screen bg-even-white-DEFAULT">
      <header className="border-b border-even-ink-100 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link
            href="/dashboard"
            className="text-xs font-medium uppercase tracking-wider text-even-ink-500 hover:text-even-navy"
          >
            ← Back to queue
          </Link>
          <span className="text-[10px] font-mono text-even-ink-400">
            patient · longitudinal view
          </span>
        </div>
      </header>

      <section className="mx-auto max-w-3xl px-6 py-8">
        {/* 1. Patient banner */}
        <div className="mb-6 rounded-xl border border-even-ink-200 bg-white p-5">
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-even-navy">
                {patient.name}
              </h1>
              <p className="mt-1 text-sm text-even-ink-600">
                {patient.age_years} y / {patient.sex ?? '—'}
                {' · '}
                <span className="font-mono">{patient.mrn}</span>
                {patient.phone_e164 ? (
                  <>
                    {' · '}
                    <span className="font-mono text-even-ink-500">
                      {patient.phone_e164}
                    </span>
                  </>
                ) : null}
              </p>
            </div>
          </div>
          {patient.known_allergies && patient.known_allergies !== 'None' && (
            <div className="inline-flex items-center gap-2 rounded-md border border-even-pink-200 bg-even-pink-50 px-3 py-1.5 text-xs font-medium text-even-pink-800">
              <span aria-hidden>⚠</span>
              <span>Allergies on file: {patient.known_allergies}</span>
            </div>
          )}
        </div>

        {/* 2. Qwen summary card */}
        <SummaryCard
          patientId={patient.id}
          summary={summary}
          summaryRow={summaryRow}
        />

        {/* 3-6. Longitudinal sections — PH.2.2 */}
        <div className="mt-6 rounded-xl border border-dashed border-even-ink-200 bg-white/40 p-5">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-even-ink-400">
            Coming in PH.2.2
          </p>
          <p className="mt-2 text-sm text-even-ink-600">
            Problem list, medication history, allergy strip, and the
            reverse-chronological encounter timeline ship in the next
            milestone. The cache is in place — the UI is being filled in.
          </p>
        </div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Summary card
// ---------------------------------------------------------------------------

function SummaryCard({
  patientId,
  summary,
  summaryRow,
}: {
  patientId: string;
  summary: ValidatedSummary | null;
  summaryRow: SummaryRow | null;
}) {
  const status = summaryRow?.status ?? 'missing';

  return (
    <div className="rounded-xl border border-even-ink-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            aria-label="AI-derived"
            className="inline-block h-2.5 w-2.5 rounded-full bg-violet-500"
          />
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-violet-800">
            AI summary
          </span>
          <StatusPill status={status} />
        </div>
        <form action={actionRecompute}>
          <input type="hidden" name="patient_id" value={patientId} />
          <button
            type="submit"
            className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-800 transition hover:border-violet-400 hover:bg-violet-100"
          >
            Recompute
          </button>
        </form>
      </div>

      {status === 'missing' && (
        <p className="text-sm text-even-ink-600">
          No summary yet. Tap Recompute to generate one — Qwen takes
          5-15s warm, up to ~50s cold.
        </p>
      )}

      {status === 'computing' && (
        <p className="text-sm text-even-ink-600">
          Computing… refresh in a few seconds.
        </p>
      )}

      {status === 'failed' && (
        <div className="rounded-md border border-even-pink-200 bg-even-pink-50 px-3 py-2 text-xs text-even-pink-800">
          Last attempt failed
          {summaryRow?.fail_reason ? (
            <>: <span className="font-mono">{summaryRow.fail_reason}</span></>
          ) : null}
          . Tap Recompute to retry.
        </div>
      )}

      {(status === 'fresh' || status === 'stale') && summary?.summary_text && (
        <p className="text-sm leading-relaxed text-even-navy">
          {summary.summary_text}
        </p>
      )}

      {summaryRow?.computed_at && (
        <p className="mt-3 text-[10px] uppercase tracking-wider text-even-ink-400">
          Computed {timeAgo(summaryRow.computed_at)}
          {summaryRow.qwen_model ? (
            <> · <span className="font-mono">{summaryRow.qwen_model}</span></>
          ) : null}
          {summaryRow.qwen_latency_ms ? (
            <> · {Math.round(summaryRow.qwen_latency_ms / 100) / 10}s</>
          ) : null}
          {summaryRow.source_encounter_count != null ? (
            <>
              {' · '}
              {summaryRow.source_encounter_count} encounter
              {summaryRow.source_encounter_count === 1 ? '' : 's'} in window
            </>
          ) : null}
        </p>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const variants: Record<string, string> = {
    fresh: 'border-even-blue-200 bg-even-blue-50 text-even-blue-800',
    computing: 'border-even-ink-200 bg-even-ink-50 text-even-ink-700',
    failed: 'border-even-pink-200 bg-even-pink-50 text-even-pink-800',
    stale: 'border-amber-300 bg-amber-50 text-amber-800',
    missing: 'border-even-ink-200 bg-white text-even-ink-500',
  };
  const cls = variants[status] ?? variants.missing;
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls}`}
    >
      {status}
    </span>
  );
}
