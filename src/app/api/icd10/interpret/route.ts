/**
 * POST /api/icd10/interpret
 *
 * v3.8 — active Qwen ICD-10 extraction from free text.
 *
 * Two consumers:
 * 1. Icd10Typeahead's "Suggest with Qwen ↩" button — passes the search
 *    input text (clinician shorthand like "T2DM" or "HTN uncontrolled").
 * 2. Assessment section's "Extract codes" button — passes the full
 *    assessment textarea contents (clinician prose).
 *
 * Body: { free_text, encounter_id? }
 * Returns: { suggestions: [{ code, label, rationale, confidence }] }
 *
 * Per V's locked decision #2: Qwen outputs ICD-10 codes freely (model
 * is well-trained on the taxonomy). Server validates format only via
 * regex ^[A-Z]\\d{2}(\\.\\d{1,2})?$ and trusts Qwen's label.
 *
 * NOT cached (free_text differs per call). Soft-fail on Qwen error.
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { qwenJson, QwenError } from '@/lib/qwen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ICD10_REGEX = /^[A-Z]\d{2}(\.\d{1,2})?$/;

type Suggestion = { code: string; label: string; rationale: string; confidence: number };

const SYSTEM_PROMPT = `You are an ICD-10 coder for an Indian OPD physician. Given a free-text clinical input (clinician shorthand, prose assessment, or partial diagnosis name), return the most likely ICD-10 codes.

You receive:
- free_text: doctor's input (may be shorthand like "T2DM", "HTN uncontrolled", or full prose like "Hypertension with target organ damage, poorly controlled diabetic")
- optional visit_reason: chief complaint context
- optional active_problems: cached patient problem list for disambiguation

Return STRICT JSON:
{
  "suggestions": [
    {
      "code": "<ICD-10 code, e.g. E11.9 or J45.901 or I10>",
      "label": "<canonical ICD-10 description>",
      "rationale": "<≤80 chars: which part of the input this code maps to>",
      "confidence": 0.5–0.95
    }
  ]
}

Rules:
- 1–8 codes, ordered most confident first.
- Use the standard ICD-10-CM format: a capital letter, two digits, optional dot + 1-2 more digits. e.g. "E11.9", "I10", "J45.901".
- Prefer well-controlled / uncomplicated codes (E11.9 over E11.65) unless the input explicitly says complications, target organ damage, or uncontrolled.
- For multi-condition inputs ("HTN + T2DM"), return separate codes for each condition.
- confidence: 0.85+ for direct unambiguous mapping; 0.70+ for typical interpretation; 0.50+ for tangential or partial match.

Return ONLY the JSON object. No markdown, no prose, no preamble.`;

export async function POST(req: Request) {
  // Auth — session OR migration secret (the secret path is for debug curl).
  const headerSecret = req.headers.get('x-migration-secret');
  const expectedSecret = process.env.MIGRATION_SECRET;
  let authed = !!expectedSecret && headerSecret === expectedSecret;
  let userId: string | null = null;
  if (!authed) {
    const session = await getCurrentUser();
    if (session) { authed = true; userId = session.id ?? null; }
  }
  if (!authed) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const body = (await req.json()) as { free_text?: string; encounter_id?: string };
  const freeText = (body.free_text ?? '').trim();
  if (freeText.length < 2) {
    return NextResponse.json({ ok: true, suggestions: [], note: 'too_short' });
  }

  // Optional encounter context (improves disambiguation but not required)
  let visitReason = '';
  let problems: string[] = [];
  if (body.encounter_id && /^[0-9a-f-]{36}$/i.test(body.encounter_id)) {
    const encRes = await pool.query<{
      patient_id: string;
      intake_visit_reason: string | null;
      chief_complaint_text: string | null;
    }>(
      `SELECT patient_id, intake_visit_reason, chief_complaint_text
       FROM encounters WHERE id = $1 LIMIT 1`,
      [body.encounter_id],
    );
    if (encRes.rows.length > 0) {
      const enc = encRes.rows[0];
      visitReason = (enc.intake_visit_reason || enc.chief_complaint_text || '').trim();
      const probRes = await pool.query<{ summary_payload: { problems?: string[] } | null }>(
        `SELECT summary_payload FROM patient_summaries WHERE patient_id = $1 LIMIT 1`,
        [enc.patient_id],
      );
      problems = probRes.rows[0]?.summary_payload?.problems ?? [];
    }
  }

  const userMessage = JSON.stringify({
    free_text: freeText,
    visit_reason: visitReason || '(none)',
    active_problems: problems,
  });

  try {
    const t0 = Date.now();
    const result = await qwenJson<{ suggestions: Array<{ code: string; label: string; rationale: string; confidence: number }> }>(
      SYSTEM_PROMPT,
      userMessage,
      { timeoutMs: 45_000 },
    );
    const latency_ms = Date.now() - t0;

    // Validate format only — per V's locked decision #2.
    const clean: Suggestion[] = (result.json.suggestions ?? [])
      .filter((s) => s.code && ICD10_REGEX.test(s.code.trim().toUpperCase()))
      .slice(0, 8)
      .map((s) => ({
        code: s.code.trim().toUpperCase(),
        label: (s.label ?? '').slice(0, 200) || s.code,
        rationale: (s.rationale ?? '').slice(0, 100),
        confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0.5)),
      }));

    return NextResponse.json({ ok: true, suggestions: clean, latency_ms });
  } catch (e) {
    const msg = e instanceof QwenError ? `Qwen ${e.kind}` : e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      ok: true,                                  // soft-fail
      suggestions: [],
      error: msg.slice(0, 200),
    });
  }
}
