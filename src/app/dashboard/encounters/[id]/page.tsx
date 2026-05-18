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
import type { PrescriptionLine } from '@/components/DrugRow';
import {
  HistoryPanel,
  type HPEncounterCard,
  type HPSummary,
  type HPProblem,
  type HPAllergy,
} from '@/components/HistoryPanel';

export const dynamic = 'force-dynamic';

type Row = EncounterEditable & {
  patient_id: string;
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
       e.patient_id,
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

  // Load any existing prescription draft (+ dispatch state) for this encounter
  const { rows: rxRows } = await pool.query<{
    id: string;
    prescription_number: string;
    lines: PrescriptionLine[] | null;
    pdf_blob_url: string | null;
    patient_sent_at: string | null;
    pharmacy_sent_at: string | null;
  }>(
    `SELECT id, prescription_number, lines, pdf_blob_url,
            patient_sent_at, pharmacy_sent_at
     FROM prescriptions WHERE encounter_id = $1 LIMIT 1`,
    [id],
  );
  const rx = rxRows[0];
  const prescriptionLines: PrescriptionLine[] = rx?.lines ?? [];

  // Load patient history for the PH.3 left panel — cached Qwen summary
  // + last 5 completed encounters. Cheap, runs in parallel-ish with
  // the prescription fetch (network round-trip dominates).
  const panelData = await loadHistoryPanelData(row.patient_id, id);
  const prescriptionMeta = rx
    ? {
        id: rx.id,
        number: rx.prescription_number,
        has_pdf: !!rx.pdf_blob_url,
        patient_sent_at: rx.patient_sent_at,
        pharmacy_sent_at: rx.pharmacy_sent_at,
      }
    : null;

  return (
    <main className="min-h-screen bg-even-white-DEFAULT">
      <HistoryPanel
        patientId={row.patient_id}
        patientName={row.patient_name}
        summary={panelData.summary}
        encounters={panelData.encounters}
      />
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

          {row.status === 'completed' && prescriptionMeta && (
            <div className="mt-4 rounded-lg border border-even-blue-100 bg-even-blue-50/60 px-3 py-2.5 text-xs text-even-navy">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-semibold">Dispatched</span>
                  <span className="ml-1 font-mono text-[11px] text-even-ink-500">
                    {prescriptionMeta.number}
                  </span>
                  {prescriptionMeta.patient_sent_at && (
                    <span className="ml-2 text-even-ink-500">
                      · patient sent
                    </span>
                  )}
                  {prescriptionMeta.pharmacy_sent_at && (
                    <span className="text-even-ink-500"> · pharmacy sent</span>
                  )}
                </div>
                {prescriptionMeta.has_pdf && (
                  <Link
                    href={`/api/prescriptions/${prescriptionMeta.id}/pdf`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-even-blue-300 bg-white px-3 py-1 text-[11px] font-semibold text-even-blue-700 hover:bg-even-blue-50"
                  >
                    View prescription PDF →
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>

        <EncounterEditor
          patient={{
            name: row.patient_name,
            mrn: row.patient_mrn,
            age_years: row.patient_age_years,
            sex: row.patient_sex,
            phone_e164: row.patient_phone_e164,
          }}
          ai={panelData.ai}
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
            prescription_lines: prescriptionLines,
          }}
        />
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// HistoryPanel data loader (PH.3.1)
// ---------------------------------------------------------------------------

/**
 * Build the props the <HistoryPanel> needs: cached summary + last 5
 * completed encounters EXCLUDING the current one (we're already in it).
 * All queries run in parallel.
 */
export type AiSmartening = {
  cc_chip_rankings: string[];
  cc_chip_additions: string[];
  disposition_recommendation: string | null;
  disposition_additions: string[];
};

async function loadHistoryPanelData(
  patientId: string,
  currentEncounterId: string,
): Promise<{
  summary: HPSummary;
  encounters: HPEncounterCard[];
  ai: AiSmartening;
}> {
  const [summaryRows, encounterRows, patientRows] = await Promise.all([
    pool.query<{
      summary: Record<string, unknown> | null;
      status: string;
      computed_at: string | null;
      fail_reason: string | null;
    }>(
      `SELECT summary, status,
              computed_at::text AS computed_at,
              fail_reason
         FROM patient_summaries WHERE patient_id = $1 LIMIT 1`,
      [patientId],
    ),
    pool.query<{
      id: string;
      encounter_date: string;
      encounter_number: string;
      chief_complaint_chips: string[] | null;
      assessment_codes: string[] | null;
      disposition: string | null;
    }>(
      `SELECT e.id,
              e.encounter_date::text AS encounter_date,
              e.encounter_number,
              e.chief_complaint_chips,
              e.assessment_codes,
              e.disposition::text AS disposition
         FROM encounters e
        WHERE e.patient_id = $1
          AND e.status = 'completed'
          AND e.id <> $2
        ORDER BY e.encounter_date DESC, e.completed_at DESC NULLS LAST
        LIMIT 5`,
      [patientId, currentEncounterId],
    ),
    pool.query<{ known_allergies: string | null }>(
      `SELECT known_allergies FROM patients WHERE id = $1 LIMIT 1`,
      [patientId],
    ),
  ]);

  const sRow = summaryRows.rows[0];
  const sObj = (sRow?.summary ?? {}) as {
    summary_text?: string;
    problem_list?: HPProblem[];
    allergy_aggregation?: { allergen?: string; source?: string }[];
    red_flags?: { kind?: string; text?: string }[];
    cc_chip_rankings?: string[];
    cc_chip_additions?: string[];
    disposition_recommendation?: string;
    disposition_additions?: string[];
  };

  // Build the allergy list (same merge logic as /patients/[id], compact).
  const seen = new Set<string>();
  const allergies: HPAllergy[] = [];
  const ownerAllergies = patientRows.rows[0]?.known_allergies ?? null;
  if (ownerAllergies && ownerAllergies !== 'None') {
    for (const piece of ownerAllergies.split(/[,;]/)) {
      const a = piece.trim();
      if (!a) continue;
      const k = a.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      allergies.push({ allergen: a, source: 'on file', fromOwner: true });
    }
  }
  for (const a of sObj.allergy_aggregation ?? []) {
    if (!a.allergen) continue;
    const k = a.allergen.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    allergies.push({ allergen: a.allergen, source: a.source ?? 'AI' });
  }
  for (const f of sObj.red_flags ?? []) {
    if (f.kind !== 'allergy' || !f.text) continue;
    const k = f.text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    allergies.push({ allergen: f.text, source: 'AI red flag' });
  }

  const summary: HPSummary = {
    status: sRow?.status ?? 'missing',
    summary_text: sObj.summary_text ?? null,
    problems: (sObj.problem_list ?? []).slice(0, 4),
    allergies,
    computed_at: sRow?.computed_at ?? null,
    fail_reason: sRow?.fail_reason ?? null,
  };

  const encounters: HPEncounterCard[] = encounterRows.rows.map((r) => ({
    id: r.id,
    encounter_date: r.encounter_date,
    encounter_number: r.encounter_number,
    chief_complaint_chips: r.chief_complaint_chips,
    primary_code: (r.assessment_codes ?? [])[0] ?? null,
    disposition: r.disposition,
  }));

  const ai: AiSmartening = {
    cc_chip_rankings: (sObj.cc_chip_rankings ?? []).filter((s): s is string => typeof s === 'string'),
    cc_chip_additions: (sObj.cc_chip_additions ?? []).filter((s): s is string => typeof s === 'string').slice(0, 3),
    disposition_recommendation: sObj.disposition_recommendation ?? null,
    disposition_additions: (sObj.disposition_additions ?? []).filter((s): s is string => typeof s === 'string').slice(0, 2),
  };

  return { summary, encounters, ai };
}
