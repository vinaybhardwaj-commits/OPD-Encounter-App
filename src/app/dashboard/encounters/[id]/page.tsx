/**
 * /dashboard/encounters/[id] — encounter screen.
 *
 * Server component: validates ownership, loads the full encounter +
 * patient row, hands editable fields to <EncounterEditor> (client).
 * Read-only viewers (completed encounters) still get the same shell —
 * the editor itself decides what to disable.
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { pool } from '@/lib/db';
import { getCurrentDoctor } from '@/lib/auth';
import { EncounterEditor, type EncounterEditable } from '@/components/EncounterEditor';

export const dynamic = 'force-dynamic';

type Row = EncounterEditable & {
  patient_name: string;
  patient_mrn: string;
  patient_age_years: number;
  patient_sex: 'M' | 'F' | 'O';
  patient_phone_e164: string | null;
  patient_allergies: string | null;
  encounter_number: string;
  chief_complaint_chips: string[] | null;
  assessment_codes: string[] | null;
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

  const { rows } = await pool.query<Row>(
    `SELECT
       e.id,
       e.encounter_number,
       e.status::text AS status,
       e.started_at,
       e.pending_diagnostic_test,
       e.chief_complaint_chips,
       e.chief_complaint_text,
       e.exam_findings,
       e.vitals,
       e.assessment_codes,
       e.assessment_text,
       e.disposition::text AS disposition,
       e.follow_up_days,
       e.referral_target,
       p.name AS patient_name,
       p.mrn AS patient_mrn,
       p.age_years AS patient_age_years,
       p.sex AS patient_sex,
       p.phone_e164 AS patient_phone_e164,
       p.known_allergies AS patient_allergies
     FROM encounters e
     JOIN patients p ON p.id = e.patient_id
     JOIN doctors d ON d.id = e.doctor_id
     WHERE e.id = $1 AND lower(d.email) = $2
     LIMIT 1`,
    [id, session.email.toLowerCase()],
  );
  const row = rows[0];
  if (!row) notFound();

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
            {row.encounter_number} · {row.status.replace('_', ' ')}
          </span>
        </div>
      </header>

      <section className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-8 border-b border-even-ink-100 pb-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-even-navy">
              {row.patient_name}
            </h1>
            <p className="text-xs font-mono text-even-ink-400">
              {row.patient_mrn}
            </p>
          </div>
          <p className="mt-1 text-sm text-even-ink-500">
            {row.patient_age_years}{row.patient_sex}
            {row.patient_phone_e164 && (
              <>
                {' · '}
                <span className="font-mono">{row.patient_phone_e164}</span>
              </>
            )}
          </p>
          {row.patient_allergies && (
            <p className="mt-3 inline-flex items-center gap-1 rounded-md bg-even-pink-100 px-2 py-1 text-xs font-medium text-even-pink-800">
              ⚠ Allergies: {row.patient_allergies}
            </p>
          )}
        </div>

        <EncounterEditor
          initial={{
            id: row.id,
            encounter_number: row.encounter_number,
            status: row.status as EncounterEditable['status'],
            started_at: row.started_at,
            pending_diagnostic_test: row.pending_diagnostic_test,
            chief_complaint_chips: row.chief_complaint_chips,
            chief_complaint_text: row.chief_complaint_text,
            exam_findings: row.exam_findings,
            vitals: row.vitals,
            assessment_codes: row.assessment_codes,
            assessment_text: row.assessment_text,
            disposition: row.disposition as EncounterEditable['disposition'],
            follow_up_days: row.follow_up_days,
            referral_target: row.referral_target,
          }}
        />
      </section>
    </main>
  );
}
