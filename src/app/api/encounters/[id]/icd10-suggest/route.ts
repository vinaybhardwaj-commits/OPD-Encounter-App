/**
 * GET /api/encounters/[id]/icd10-suggest
 *
 * v3.8 — passive Qwen ICD-10 suggestions from encounter context.
 *
 * Auto-fires from <Icd10SuggestedChips> on mount. Pulls visit_reason +
 * active_problems + assessment text + last 5 encounters as context.
 * Hashes inputs (sha256 truncated to 24 chars); cache hit returns
 * immediately. Stores result in encounters.ai_suggested_icd10 JSONB +
 * generated_at + context_hash (migration v27).
 *
 * Same provenance pattern as v3.5a (suggest-orders): server validates
 * Qwen output format via ICD-10 regex.
 *
 * Soft-fail: returns { status: 'failed' } with HTTP 200 so the typeahead
 * stays usable.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { qwenJson, QwenError } from '@/lib/qwen';
import { loadComorbidityContext, comorbidityContextForPrompt } from '@/lib/patient-comorbidity-context';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const ICD10_REGEX = /^[A-Z]\d{2}(\.\d{1,2})?$/;

type Suggestion = { code: string; label: string; rationale: string; confidence: number };
type CachedPayload =
  | { status: 'ok'; findings: Suggestion[]; generated_at: string; latency_ms: number }
  | { status: 'failed'; error: string; generated_at: string };

const SYSTEM_PROMPT = `You are an ICD-10 coder for an Indian OPD physician. Given the encounter context (visit reason, active problems, brief recent encounters, and any draft assessment), suggest the most likely ICD-10 codes the doctor is converging on.

Return STRICT JSON:
{
  "findings": [
    {
      "code": "<ICD-10 code, e.g. E11.9 or I10>",
      "label": "<canonical ICD-10 description>",
      "rationale": "<≤100 chars: which signal in context informs this>",
      "confidence": 0.5–0.95
    }
  ]
}

Rules:
- 1–6 findings, ordered most likely first.
- Use ICD-10-CM format: capital letter, two digits, optional dot + 1-2 more digits.
- Prefer well-controlled / uncomplicated codes unless evidence says otherwise.
- Only suggest a code when the encounter context actually supports it. Empty findings array is fine.

Return ONLY the JSON object.`;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
  const headerSecret = req.headers.get('x-migration-secret');
    const expectedSecret = process.env.MIGRATION_SECRET;
    let authed = !!expectedSecret && headerSecret === expectedSecret;
    if (!authed) {
      const session = await getCurrentUser();
      if (session) authed = true;
    }
    if (!authed) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  
    const { id: encounterId } = await ctx.params;
  
    const encRes = await pool.query<{
      id: string;
      patient_id: string;
      intake_visit_reason: string | null;
      chief_complaint_text: string | null;
      assessment_text: string | null;
      ai_suggested_icd10: CachedPayload | null;
      ai_suggested_icd10_context_hash: string | null;
    }>(
      `SELECT id, patient_id, intake_visit_reason, chief_complaint_text,
              assessment_text, ai_suggested_icd10, ai_suggested_icd10_context_hash
       FROM encounters WHERE id = $1 LIMIT 1`,
      [encounterId],
    );
    if (encRes.rows.length === 0) {
      return NextResponse.json({ ok: false, error: 'encounter_not_found' }, { status: 404 });
    }
    const enc = encRes.rows[0];
    const visitReason = (enc.intake_visit_reason || enc.chief_complaint_text || '').trim();
    const assessment = (enc.assessment_text || '').trim();
  
    const [problemsRes, recentRes] = await Promise.all([
      pool.query<{ summary: { problems?: string[] } | null }>(
        `SELECT summary FROM patient_summaries WHERE patient_id = $1 LIMIT 1`,
        [enc.patient_id],
      ),
      pool.query<{ encounter_date: string; chief_complaint_text: string | null; assessment_text: string | null }>(
        `SELECT encounter_date::text, chief_complaint_text, assessment_text
         FROM encounters
         WHERE patient_id = $1 AND id != $2 AND status='completed'
         ORDER BY encounter_date DESC LIMIT 5`,
        [enc.patient_id, encounterId],
      ),
    ]);
    const problems = problemsRes.rows[0]?.summary?.problems ?? [];
  
    const contextHash = createHash('sha256')
      .update(JSON.stringify({ visitReason, problems, assessment, recentCount: recentRes.rows.length }))
      .digest('hex')
      .slice(0, 24);
  
    if (enc.ai_suggested_icd10_context_hash === contextHash && enc.ai_suggested_icd10) {
      return NextResponse.json({ ok: true, cached: true, payload: enc.ai_suggested_icd10 });
    }
  
    // v3.9.1b — comorbidity-aware prompt context
  const comorbidityCtx = await loadComorbidityContext(enc.patient_id).catch(() => null);

  const userMessage = JSON.stringify({
      visit_reason: visitReason || '(none)',
      active_problems: problems,
      draft_assessment: assessment || '(none yet)',
      recent_encounters: recentRes.rows.map((r) => ({
        date: r.encounter_date,
        cc: (r.chief_complaint_text || '').slice(0, 100),
        assessment: (r.assessment_text || '').slice(0, 200),
      })),
      ...(comorbidityCtx ? comorbidityContextForPrompt(comorbidityCtx) : {})
    });
  
    let payload: CachedPayload;
    try {
      const t0 = Date.now();
      const result = await qwenJson<{ findings: Array<{ code: string; label: string; rationale: string; confidence: number }> }>(
        SYSTEM_PROMPT,
        userMessage,
        { timeoutMs: 60_000 },
      );
      const latency_ms = Date.now() - t0;
  
      const clean: Suggestion[] = (result.json.findings ?? [])
        .filter((f) => f.code && ICD10_REGEX.test(f.code.trim().toUpperCase()))
        .slice(0, 6)
        .map((f) => ({
          code: f.code.trim().toUpperCase(),
          label: (f.label ?? '').slice(0, 200) || f.code,
          rationale: (f.rationale ?? '').slice(0, 120),
          confidence: Math.max(0, Math.min(1, Number(f.confidence) || 0.5)),
        }));
  
      payload = {
        status: 'ok',
        findings: clean,
        generated_at: new Date().toISOString(),
        latency_ms,
      };
    } catch (e) {
      const msg = e instanceof QwenError ? `Qwen ${e.kind}` : e instanceof Error ? e.message : String(e);
      payload = {
        status: 'failed',
        error: msg.slice(0, 200),
        generated_at: new Date().toISOString(),
      };
    }
  
    await pool.query(
      `UPDATE encounters
       SET ai_suggested_icd10 = $2::jsonb,
           ai_suggested_icd10_generated_at = NOW(),
           ai_suggested_icd10_context_hash = $3
       WHERE id = $1`,
      [encounterId, JSON.stringify(payload), contextHash],
    );
  
    return NextResponse.json({ ok: true, cached: false, payload });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[icd10-suggest] uncaught", msg);
    return NextResponse.json({ ok: false, error: "server_error", detail: msg.slice(0, 300) }, { status: 500 });
  }

}
