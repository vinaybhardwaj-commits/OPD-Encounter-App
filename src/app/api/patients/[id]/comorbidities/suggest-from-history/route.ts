/**
 * POST /api/patients/[id]/comorbidities/suggest-from-history
 *
 * v3.9.2 — Qwen reads patient's past 10 completed encounters
 * (assessment_text + assessment_codes + prescription_lines) plus the
 * Qwen-derived patient_summaries.summary.problems as a hint, and
 * extracts CHRONIC conditions repeatedly mentioned.
 *
 * Returns: { suggestions: [{ code, label, rationale, confidence }] }
 * each one a deduplicated chronic ICD-10 code NOT already on the
 * patient's canonical comorbidity list.
 *
 * Provenance: format regex validates ICD-10. Catalog match optional
 * — if a returned code maps to a CORE_x or EXT_x catalog entry, the
 * client renders with the canonical label; otherwise Qwen's label
 * is used. Soft-fail HTTP 200 with empty suggestions on Qwen error.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { qwenJson, QwenError } from '@/lib/qwen';
import { isValidIcd10 } from '@/lib/comorbidities-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

type Suggestion = { code: string; label: string; rationale: string; confidence: number };

const SYSTEM_PROMPT = `You are an Indian OPD physician's comorbidity-extraction assistant. Given a patient's history (past 5-10 completed encounters with assessments + prescriptions, plus a hint list of auto-derived problems), identify CHRONIC conditions worth promoting to the patient's longitudinal comorbidity list.

A condition is "chronic" if it (a) appears as the focus of multiple encounters, (b) is on ongoing medication, (c) is referenced as a "history of" or "long-standing" diagnosis in assessments, or (d) belongs to a chronic-disease ICD-10 family (E10/E11/I10/I25/I50/N18/J44/J45/F32/F41/M06/etc.).

Return STRICT JSON:
{
  "suggestions": [
    {
      "code": "<ICD-10 code, e.g. E11.9 or I10>",
      "label": "<canonical short description>",
      "rationale": "<≤100 chars: evidence from the history>",
      "confidence": 0.5–0.95
    }
  ]
}

Rules:
- 1–10 suggestions, ordered most confident first.
- ICD-10-CM format: capital letter, two digits, optional dot + 1-4 more digits.
- PREFER uncomplicated codes (E11.9 over E11.65) unless evidence in history explicitly mentions a complication.
- DO NOT suggest acute conditions (acute infections, transient symptoms, post-op states).
- DO NOT suggest codes already on the patient's current comorbidity list (provided).
- confidence: 0.85+ if mentioned in 3+ encounters or matched by current Rx; 0.70+ if mentioned in 2 encounters or in problems list; 0.50+ if single mention + chronic pattern.

Return ONLY the JSON object. No markdown, no preamble.`;

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getCurrentUser();
    if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

    const { id: patientId } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(patientId)) {
      return NextResponse.json({ ok: false, error: 'bad_id' }, { status: 400 });
    }

    // Load: patient demographics, last 10 completed encounters with codes + Rx, current comorbidities, auto-derived problems
    const [patRes, encsRes, currentRes, summRes] = await Promise.all([
      pool.query<{ age_years: number; sex: string }>(
        `SELECT age_years, sex FROM patients WHERE id = $1 LIMIT 1`,
        [patientId],
      ),
      pool.query<{
        encounter_date: string;
        assessment_text: string | null;
        assessment_codes: string[] | null;
        assessment_code_labels: Record<string, string> | null;
      }>(
        `SELECT encounter_date::text, assessment_text,
                assessment_codes, assessment_code_labels
         FROM encounters
         WHERE patient_id = $1 AND status = 'completed'
         ORDER BY encounter_date DESC
         LIMIT 10`,
        [patientId],
      ),
      pool.query<{ code: string }>(
        `SELECT code FROM patient_comorbidities WHERE patient_id = $1 AND is_resolved = false`,
        [patientId],
      ),
      pool.query<{ summary: { problems?: Array<{ label?: string }> } | null }>(
        `SELECT summary FROM patient_summaries WHERE patient_id = $1 LIMIT 1`,
        [patientId],
      ),
    ]);

    if (patRes.rows.length === 0) {
      return NextResponse.json({ ok: false, error: 'patient_not_found' }, { status: 404 });
    }
    if (encsRes.rows.length === 0) {
      return NextResponse.json({ ok: true, suggestions: [], note: 'no_completed_encounters' });
    }

    const currentCodes = new Set(currentRes.rows.map((r) => r.code.toUpperCase()));

    // Also pull prescription lines per encounter
    const encounterIds: string[] = [];
    // Re-query encounter IDs in the same order as encsRes — we lost them in the SELECT above
    const idsRes = await pool.query<{ id: string }>(
      `SELECT id FROM encounters
       WHERE patient_id = $1 AND status = 'completed'
       ORDER BY encounter_date DESC LIMIT 10`,
      [patientId],
    );
    for (const r of idsRes.rows) encounterIds.push(r.id);

    const rxRes = encounterIds.length > 0
      ? await pool.query<{ encounter_id: string; lines: unknown }>(
          `SELECT encounter_id, lines FROM prescriptions WHERE encounter_id = ANY($1::uuid[])`,
          [encounterIds],
        )
      : { rows: [] };
    const rxByEncounter = new Map(rxRes.rows.map((r) => [r.encounter_id, r.lines]));

    const auto_derived_problems = (summRes.rows[0]?.summary?.problems ?? [])
      .map((p) => p.label)
      .filter((l): l is string => !!l)
      .slice(0, 10);

    const userMessage = JSON.stringify({
      patient_demographics: { age: patRes.rows[0].age_years, sex: patRes.rows[0].sex },
      current_comorbidities: Array.from(currentCodes),
      past_encounters: encsRes.rows.map((e, i) => ({
        date: e.encounter_date,
        assessment_text: (e.assessment_text || '').slice(0, 400),
        assessment_codes: e.assessment_codes ?? [],
        assessment_code_labels: e.assessment_code_labels ?? {},
        prescription: rxByEncounter.get(encounterIds[i]) ?? null,
      })),
      auto_derived_problems_hint: auto_derived_problems,
    });

    const t0 = Date.now();
    const result = await qwenJson<{ suggestions: Array<{ code: string; label: string; rationale: string; confidence: number }> }>(
      SYSTEM_PROMPT,
      userMessage,
      { timeoutMs: 60_000 },
    );
    const latency_ms = Date.now() - t0;

    const clean: Suggestion[] = (result.json.suggestions ?? [])
      .filter((s) => s.code && isValidIcd10(s.code.trim().toUpperCase()))
      .filter((s) => !currentCodes.has(s.code.trim().toUpperCase()))
      .slice(0, 10)
      .map((s) => ({
        code: s.code.trim().toUpperCase(),
        label: (s.label ?? '').slice(0, 200) || s.code,
        rationale: (s.rationale ?? '').slice(0, 120),
        confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0.5)),
      }));

    return NextResponse.json({
      ok: true,
      suggestions: clean,
      latency_ms,
      encounters_scanned: encsRes.rows.length,
    });
  } catch (e) {
    const msg = e instanceof QwenError ? `Qwen ${e.kind}` : e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: true, suggestions: [], error: msg.slice(0, 200) });
  }
}
