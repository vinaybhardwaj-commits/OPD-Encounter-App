/**
 * /dashboard/encounters/[id] — M2.2 stub.
 *
 * The fully-featured encounter screen (chief complaint, vitals, exam,
 * assessment, disposition + Submit & finish) ships in M2.3. For M2.2,
 * this exists so the queue cards have a working link target — and to
 * confirm encounter creation actually wrote a row.
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { pool } from '@/lib/db';
import { getCurrentDoctor } from '@/lib/auth';

export const dynamic = 'force-dynamic';

type EncounterRow = {
  id: string;
  encounter_number: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  pending_diagnostic_test: string | null;
  chief_complaint_text: string | null;
  exam_findings: string | null;
  assessment_text: string | null;
  disposition: string | null;
  patient_name: string;
  patient_mrn: string;
  patient_age_years: number;
  patient_sex: string;
};

export default async function EncounterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getCurrentDoctor();
  if (!session) redirect('/auth/login');

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const { rows } = await pool.query<EncounterRow>(
    `SELECT e.id, e.encounter_number, e.status::text AS status, e.started_at,
            e.completed_at, e.pending_diagnostic_test, e.chief_complaint_text,
            e.exam_findings, e.assessment_text, e.disposition::text AS disposition,
            p.name AS patient_name, p.mrn AS patient_mrn,
            p.age_years AS patient_age_years, p.sex AS patient_sex
     FROM encounters e
     JOIN patients p ON p.id = e.patient_id
     JOIN doctors d ON d.id = e.doctor_id
     WHERE e.id = $1 AND lower(d.email) = $2
     LIMIT 1`,
    [id, session.email.toLowerCase()],
  );
  const enc = rows[0];
  if (!enc) notFound();

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
            {enc.encounter_number}
          </span>
        </div>
      </header>

      <section className="mx-auto max-w-3xl px-6 py-10">
        <p className="mb-1 text-xs font-medium uppercase tracking-[0.18em] text-even-blue-700">
          Encounter · {enc.status.replace('_', ' ')}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-even-navy">
          {enc.patient_name}
        </h1>
        <p className="text-sm text-even-ink-500">
          {enc.patient_age_years}{enc.patient_sex} · {enc.patient_mrn}
        </p>

        <div className="mt-8 rounded-xl border border-dashed border-even-ink-200 bg-white p-6 text-sm text-even-ink-500">
          <p className="mb-2 font-medium text-even-navy">
            M2.3 ships the full encounter screen.
          </p>
          <p className="text-xs text-even-ink-500">
            Chief complaint, vitals, exam findings, assessment, disposition,
            and Submit &amp; finish all arrive in the next milestone. This
            stub exists so the queue&apos;s links resolve and so you can
            confirm encounter creation wrote a row.
          </p>
          {enc.chief_complaint_text && (
            <div className="mt-4 border-t border-even-ink-100 pt-4">
              <p className="text-[11px] uppercase tracking-wider text-even-ink-400">Chief complaint (seeded)</p>
              <p className="mt-1 text-sm text-even-navy">{enc.chief_complaint_text}</p>
            </div>
          )}
          {enc.pending_diagnostic_test && (
            <div className="mt-4 border-t border-even-ink-100 pt-4">
              <p className="text-[11px] uppercase tracking-wider text-even-ink-400">Pending test</p>
              <p className="mt-1 text-sm text-even-navy">{enc.pending_diagnostic_test}</p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
