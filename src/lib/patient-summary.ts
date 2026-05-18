/**
 * Patient summary — input serialiser, prompt builder, and output validator.
 *
 * The Qwen client (`src/lib/qwen.ts`) handles transport. This module
 * handles the structured input we ship and the JSON shape we expect
 * back, per OPD-PATIENT-HISTORY-PRD §4.1.
 *
 * Output JSON schema:
 *   {
 *     summary_text: string (2-3 lines)
 *     problem_list: [{ label, since, status, current_meds[], last_managed_at, source_encounters[] }]
 *     medication_history: [{ generic, active, first_prescribed, last_prescribed, frequency_normal }]
 *     allergy_aggregation: [{ allergen, source, confidence }]
 *     cc_chip_rankings: string[24]
 *     cc_chip_additions: string[0..3]
 *     disposition_recommendation: enum
 *     disposition_additions: string[0..2]
 *     red_flags: [{ kind, text, severity }]
 *   }
 *
 * Validation is shape-only: required keys present, arrays are arrays, etc.
 * Anything else falls through as best-effort — the UI tolerates missing
 * fields, and the audit row records a 'schema_violation' result.
 */

import { pool } from '@/lib/db';
import { CC_CHIPS } from '@/lib/cc-chips';

// -----------------------------------------------------------------------------
// Input gathering
// -----------------------------------------------------------------------------

export type PatientDemographics = {
  id: string;
  mrn: string;
  name: string;
  age_years: number;
  sex: string | null;
  known_allergies: string | null;
};

export type EncounterForPrompt = {
  encounter_number: string;
  encounter_date: string; // YYYY-MM-DD
  chief_complaint_chips: string[] | null;
  chief_complaint_text: string | null;
  exam_findings: string | null;
  assessment_codes: string[] | null;
  assessment_text: string | null;
  disposition: string | null;
  follow_up_days: number | null;
  referral_target: string | null;
  prescription_lines: unknown | null;
};

export type SummaryInputBundle = {
  demographics: PatientDemographics;
  encounters: EncounterForPrompt[];
  window_start: string; // ISO date
  window_end: string;
};

/**
 * Pulls past 10 completed encounters OR 12 months (whichever is broader)
 * for the given patient, with prescription lines joined in. Newest first.
 */
export async function buildSummaryInput(patientId: string): Promise<SummaryInputBundle | null> {
  const { rows: pRows } = await pool.query<PatientDemographics>(
    `SELECT id, mrn, name, age_years, sex, known_allergies
       FROM patients WHERE id = $1 LIMIT 1`,
    [patientId],
  );
  const demographics = pRows[0];
  if (!demographics) return null;

  // Past-12-months OR past-10 encounters: union and dedupe by id.
  // Cheaper to compute server-side as one query with a UNION.
  const { rows: encRows } = await pool.query<EncounterForPrompt & { id: string }>(
    `WITH base AS (
       SELECT e.id, e.encounter_number,
              e.encounter_date::text AS encounter_date,
              e.chief_complaint_chips, e.chief_complaint_text,
              e.exam_findings, e.assessment_codes, e.assessment_text,
              e.disposition::text AS disposition,
              e.follow_up_days, e.referral_target,
              p.lines AS prescription_lines,
              e.completed_at
         FROM encounters e
         LEFT JOIN prescriptions p ON p.encounter_id = e.id
        WHERE e.patient_id = $1
          AND e.status = 'completed'
     )
     SELECT * FROM (
       (SELECT id, encounter_number, encounter_date,
               chief_complaint_chips, chief_complaint_text,
               exam_findings, assessment_codes, assessment_text,
               disposition, follow_up_days, referral_target,
               prescription_lines, completed_at
          FROM base
         WHERE encounter_date >= (CURRENT_DATE - INTERVAL '365 days')
         ORDER BY encounter_date DESC, completed_at DESC)
       UNION
       (SELECT id, encounter_number, encounter_date,
               chief_complaint_chips, chief_complaint_text,
               exam_findings, assessment_codes, assessment_text,
               disposition, follow_up_days, referral_target,
               prescription_lines, completed_at
          FROM base
         ORDER BY encounter_date DESC, completed_at DESC
         LIMIT 10)
     ) merged
     ORDER BY encounter_date DESC, completed_at DESC`,
    [patientId],
  );

  // Compute window bounds. If no completed encounters, return empty window.
  const dates = encRows.map((r) => r.encounter_date).filter(Boolean);
  const window_end = dates[0] ?? new Date().toISOString().slice(0, 10);
  const window_start = dates[dates.length - 1] ?? window_end;

  // Strip the `id` and `completed_at` helper columns from the payload.
  const encounters: EncounterForPrompt[] = encRows.map((r) => ({
    encounter_number: r.encounter_number,
    encounter_date: r.encounter_date,
    chief_complaint_chips: r.chief_complaint_chips,
    chief_complaint_text: r.chief_complaint_text,
    exam_findings: r.exam_findings,
    assessment_codes: r.assessment_codes,
    assessment_text: r.assessment_text,
    disposition: r.disposition,
    follow_up_days: r.follow_up_days,
    referral_target: r.referral_target,
    prescription_lines: r.prescription_lines,
  }));

  return { demographics, encounters, window_start, window_end };
}

// -----------------------------------------------------------------------------
// Prompt construction
// -----------------------------------------------------------------------------

export const SUMMARY_SYSTEM_PROMPT = `
You are a clinical summarisation assistant for OPD doctors at Even Hospital in Bengaluru, India.

You will be given:
  - patient demographics
  - the patient's past OPD encounters (chronological, newest first)
  - the catalogue of 24 standard chief-complaint chips the doctor can pick from
  - the catalogue of 6 standard disposition values

Your job is to return ONE JSON object summarising the patient's clinical history and predicting what the doctor will likely need to capture in TODAY's encounter. The doctor will see this output in a side panel while documenting.

Rules:
  - Output ONLY valid JSON. No prose, no markdown.
  - Be concise. Doctors scan, they do not read.
  - Use Indian generic-drug naming conventions (Telmisartan not Micardis).
  - If a problem appears resolved (e.g., URTI from 18 months ago, no recurrence), do not list it as active.
  - For cc_chip_rankings: re-rank ALL 24 standard chips in the order most likely to be relevant for this patient. Use exact chip labels from the provided catalogue. Do not invent.
  - For cc_chip_additions: 0 to 3 patient-specific net-new chip labels (e.g., "BP medication review", "HbA1c due"). These do NOT need to be in the standard catalogue.
  - For disposition_recommendation: pick ONE of: discharge, follow_up, admit, refer, observe, send_diagnostics.
  - For disposition_additions: 0 to 2 short labels naming specialist referrals if relevant (e.g., "Refer to Dr. Iyer · Cardiology"). Empty array if none.
  - For red_flags: 0 to 5 items covering critical drug allergies, dangerous interactions, or recurring acute conditions.
  - Dates use YYYY-MM-DD or YYYY-MM. Use null if unknown.

Required output shape:
{
  "summary_text": "2-3 short sentences",
  "problem_list": [{ "label": "string", "since": "YYYY-MM|null", "status": "active|controlled|resolved", "current_meds": ["string"], "last_managed_at": "YYYY-MM-DD|null", "source_encounters": ["ENC-..."] }],
  "medication_history": [{ "generic": "string", "active": true|false, "first_prescribed": "YYYY-MM|null", "last_prescribed": "YYYY-MM-DD|null", "frequency_normal": "string" }],
  "allergy_aggregation": [{ "allergen": "string", "source": "string", "confidence": "high|medium|low" }],
  "cc_chip_rankings": ["24 items, all from the standard catalogue, re-ordered"],
  "cc_chip_additions": ["0-3 patient-specific chip labels"],
  "disposition_recommendation": "discharge|follow_up|admit|refer|observe|send_diagnostics",
  "disposition_additions": ["0-2 strings"],
  "red_flags": [{ "kind": "allergy|drug_interaction|recurrence|other", "text": "string", "severity": "high|medium|low" }]
}
`.trim();

export function buildSummaryUserMessage(bundle: SummaryInputBundle): string {
  const standardChips = CC_CHIPS.map((c) => c.label);
  const standardDispositions = [
    'discharge',
    'follow_up',
    'admit',
    'refer',
    'observe',
    'send_diagnostics',
  ];

  return JSON.stringify(
    {
      patient: bundle.demographics,
      standard_cc_chips: standardChips,
      standard_dispositions: standardDispositions,
      window: { start: bundle.window_start, end: bundle.window_end },
      encounters: bundle.encounters,
    },
    null,
    2,
  );
}

// -----------------------------------------------------------------------------
// Output validation (shape-only, lenient)
// -----------------------------------------------------------------------------

export type ValidatedSummary = {
  summary_text: string;
  problem_list: unknown[];
  medication_history: unknown[];
  allergy_aggregation: unknown[];
  cc_chip_rankings: string[];
  cc_chip_additions: string[];
  disposition_recommendation: string;
  disposition_additions: string[];
  red_flags: unknown[];
};

export type ValidationResult =
  | { ok: true; value: ValidatedSummary }
  | { ok: false; reason: string };

const ALLOWED_DISPOSITIONS = new Set([
  'discharge',
  'follow_up',
  'admit',
  'refer',
  'observe',
  'send_diagnostics',
]);

export function validateSummary(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not_object' };
  const r = raw as Record<string, unknown>;

  const summary_text = typeof r.summary_text === 'string' ? r.summary_text : null;
  if (!summary_text) return { ok: false, reason: 'missing_summary_text' };

  const problem_list = Array.isArray(r.problem_list) ? r.problem_list : null;
  if (!problem_list) return { ok: false, reason: 'missing_problem_list' };

  const medication_history = Array.isArray(r.medication_history) ? r.medication_history : null;
  if (!medication_history) return { ok: false, reason: 'missing_medication_history' };

  const allergy_aggregation = Array.isArray(r.allergy_aggregation) ? r.allergy_aggregation : null;
  if (!allergy_aggregation) return { ok: false, reason: 'missing_allergy_aggregation' };

  const cc_chip_rankings = Array.isArray(r.cc_chip_rankings)
    ? r.cc_chip_rankings.filter((x): x is string => typeof x === 'string')
    : null;
  if (!cc_chip_rankings) return { ok: false, reason: 'missing_cc_chip_rankings' };

  const cc_chip_additions = Array.isArray(r.cc_chip_additions)
    ? r.cc_chip_additions.filter((x): x is string => typeof x === 'string')
    : [];

  const dispRec = typeof r.disposition_recommendation === 'string' ? r.disposition_recommendation : null;
  if (!dispRec) return { ok: false, reason: 'missing_disposition_recommendation' };
  if (!ALLOWED_DISPOSITIONS.has(dispRec)) {
    return { ok: false, reason: `bad_disposition_recommendation:${dispRec}` };
  }

  const disposition_additions = Array.isArray(r.disposition_additions)
    ? r.disposition_additions.filter((x): x is string => typeof x === 'string')
    : [];

  const red_flags = Array.isArray(r.red_flags) ? r.red_flags : [];

  return {
    ok: true,
    value: {
      summary_text,
      problem_list,
      medication_history,
      allergy_aggregation,
      cc_chip_rankings,
      cc_chip_additions,
      disposition_recommendation: dispRec,
      disposition_additions,
      red_flags,
    },
  };
}
