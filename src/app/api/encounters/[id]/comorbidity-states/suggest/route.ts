/**
 * GET /api/encounters/[id]/comorbidity-states/suggest
 *
 * v3.9.5 — Qwen reads the encounter's assessment_text + the patient's
 * active comorbidities (with captured_as dimensions from the EHS
 * Catalog) and suggests control_state / severity_state for each.
 *
 * Cached on encounters.ai_suggested_comorbidity_states JSONB. Hash:
 * sha256(assessment_text + active_codes). Re-fires if either changes.
 * Soft-fail HTTP 200 with empty findings on Qwen error.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { qwenJson, QwenError } from '@/lib/qwen';
import { lookupByIcd10Anchor } from '@/lib/comorbidities-catalog';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type ControlState = 'well' | 'partial' | 'uncontrolled';
type SeverityState = 'mild' | 'moderate' | 'severe';

type Suggestion = {
  comorbidity_id: string;
  code: string;
  control_state: ControlState | null;
  severity_state: SeverityState | null;
  rationale: string;
};

type CachedPayload =
  | { status: 'ok'; findings: Suggestion[]; generated_at: string; latency_ms: number }
  | { status: 'failed'; error: string; generated_at: string }
  | { status: 'not_eligible'; reason: string; generated_at: string };

const SYSTEM_PROMPT = `You are an Indian OPD physician's assistant. Given a patient's active comorbidities and the doctor's encounter assessment, infer the CONTROL or SEVERITY state for each comorbidity based on what the assessment says.

You receive:
- assessment_text: the doctor's free-text assessment for this encounter
- comorbidities: array of { id, code, label, captured_as, control_dimension?, severity_dimension? }
  - captured_as = 'binary+control' → infer control_state if mentioned
  - captured_as = 'binary+severity' → infer severity_state if mentioned
  - captured_as = 'binary' or 'risk_factor' → skip (no states apply)

Return STRICT JSON:
{
  "findings": [
    {
      "comorbidity_id": "<the id from input>",
      "code": "<the ICD-10 code>",
      "control_state": "well" | "partial" | "uncontrolled" | null,
      "severity_state": "mild" | "moderate" | "severe" | null,
      "rationale": "<≤80 chars: which words in the assessment imply this>"
    }
  ]
}

Rules:
- Only include comorbidities where the assessment text gives concrete signal (numeric values, "controlled / uncontrolled / poorly controlled / well managed", severity words).
- Skip if no signal: omit from findings rather than guess.
- For binary+control: 'well' if values are in target / 'controlled' / 'well managed'; 'partial' if borderline; 'uncontrolled' if 'poorly controlled' / values outside target.
- For binary+severity: 'mild' / 'moderate' / 'severe' from adjectives or numerical scales (CKD stage, NYHA, COPD GOLD, asthma steps).
- Only the dimension that applies (control OR severity) is set; the other stays null.

Return ONLY the JSON object. No markdown, no preamble.`;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getCurrentUser();
    if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

    const { id: encounterId } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(encounterId)) {
      return NextResponse.json({ ok: false, error: 'bad_id' }, { status: 400 });
    }

    const encRes = await pool.query<{
      patient_id: string;
      assessment_text: string | null;
      ai_suggested_comorbidity_states: CachedPayload | null;
      ai_suggested_comorbidity_states_context_hash: string | null;
    }>(
      `SELECT patient_id, assessment_text,
              ai_suggested_comorbidity_states,
              ai_suggested_comorbidity_states_context_hash
       FROM encounters WHERE id = $1 LIMIT 1`,
      [encounterId],
    );
    if (encRes.rows.length === 0) {
      return NextResponse.json({ ok: false, error: 'encounter_not_found' }, { status: 404 });
    }
    const enc = encRes.rows[0];
    const assessment = (enc.assessment_text ?? '').trim();

    if (assessment.length < 10) {
      const payload: CachedPayload = {
        status: 'not_eligible',
        reason: 'assessment_too_short',
        generated_at: new Date().toISOString(),
      };
      return NextResponse.json({ ok: true, cached: false, payload });
    }

    const comRes = await pool.query<{ id: string; code: string; label: string }>(
      `SELECT id, code, label FROM patient_comorbidities
       WHERE patient_id = $1 AND is_resolved = false
       ORDER BY added_at DESC`,
      [enc.patient_id],
    );
    if (comRes.rows.length === 0) {
      const payload: CachedPayload = {
        status: 'not_eligible',
        reason: 'no_active_comorbidities',
        generated_at: new Date().toISOString(),
      };
      return NextResponse.json({ ok: true, cached: false, payload });
    }

    const annotated = comRes.rows
      .map((c) => {
        const cat = lookupByIcd10Anchor(c.code);
        return {
          id: c.id,
          code: c.code,
          label: c.label,
          captured_as: cat?.captured_as ?? 'binary',
          control_dimension: cat?.control_dimension ?? null,
          severity_dimension: cat?.severity_dimension ?? null,
        };
      })
      .filter((c) => c.captured_as === 'binary+control' || c.captured_as === 'binary+severity');

    if (annotated.length === 0) {
      const payload: CachedPayload = {
        status: 'not_eligible',
        reason: 'no_stateful_comorbidities',
        generated_at: new Date().toISOString(),
      };
      return NextResponse.json({ ok: true, cached: false, payload });
    }

    const contextHash = createHash('sha256')
      .update(JSON.stringify({ a: assessment, c: annotated.map((c) => c.id) }))
      .digest('hex')
      .slice(0, 24);

    if (enc.ai_suggested_comorbidity_states_context_hash === contextHash && enc.ai_suggested_comorbidity_states) {
      return NextResponse.json({ ok: true, cached: true, payload: enc.ai_suggested_comorbidity_states });
    }

    let payload: CachedPayload;
    try {
      const t0 = Date.now();
      const result = await qwenJson<{ findings: Array<{ comorbidity_id: string; code: string; control_state: string | null; severity_state: string | null; rationale: string }> }>(
        SYSTEM_PROMPT,
        JSON.stringify({ assessment_text: assessment, comorbidities: annotated }),
        { timeoutMs: 45_000 },
      );
      const latency_ms = Date.now() - t0;
      const findings: Suggestion[] = (result.json.findings ?? [])
        .map((f) => {
          const com = annotated.find((c) => c.id === f.comorbidity_id);
          if (!com) return null;
          const control = f.control_state && ['well','partial','uncontrolled'].includes(f.control_state) ? (f.control_state as ControlState) : null;
          const severity = f.severity_state && ['mild','moderate','severe'].includes(f.severity_state) ? (f.severity_state as SeverityState) : null;
          if (!control && !severity) return null;
          return {
            comorbidity_id: com.id,
            code: com.code,
            control_state: control,
            severity_state: severity,
            rationale: (f.rationale ?? '').slice(0, 100),
          };
        })
        .filter((x): x is Suggestion => x !== null);

      payload = {
        status: 'ok',
        findings,
        generated_at: new Date().toISOString(),
        latency_ms,
      };
    } catch (e) {
      const msg = e instanceof QwenError ? `Qwen ${e.kind}` : e instanceof Error ? e.message : String(e);
      payload = { status: 'failed', error: msg.slice(0, 200), generated_at: new Date().toISOString() };
    }

    await pool.query(
      `UPDATE encounters
       SET ai_suggested_comorbidity_states = $2::jsonb,
           ai_suggested_comorbidity_states_generated_at = NOW(),
           ai_suggested_comorbidity_states_context_hash = $3
       WHERE id = $1`,
      [encounterId, JSON.stringify(payload), contextHash],
    );

    return NextResponse.json({ ok: true, cached: false, payload });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: 'server_error', detail: msg.slice(0, 300) }, { status: 500 });
  }
}
