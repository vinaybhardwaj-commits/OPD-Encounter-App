/**
 * GET /api/encounters/[id]/suggest-orders
 *
 * v3.5a — passive Qwen-driven order suggestions from encounter context.
 *
 * Returns 3–8 catalog suggestions Qwen thinks the doctor should consider
 * given the visit_reason, active problems, and last 5 encounters. Caches
 * to encounters.ai_suggested_orders (JSONB) + context_hash so a re-open
 * with the same context is free.
 *
 * Provenance: builds an allowed_catalog subset (top 200 by keyword
 * relevance to context + alphabetic fallback). Qwen receives only
 * those service_codes; server-side filter rejects anything Qwen
 * hallucinates outside the sent set. Same always-warn-never-block
 * pattern as v2 DDx.
 *
 * Failure: returns { status: 'failed' } with HTTP 200. Strip renders no
 * chips, no error toast. Search still works.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { qwenJson, QwenError } from '@/lib/qwen';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

type Suggestion = {
  service_code: string;
  display_name: string;
  sub_department: string;
  modality: 'lab' | 'imaging' | 'cardiology' | 'procedure';
  rationale: string;
  confidence: number;
};

type CachedPayload =
  | { status: 'ok'; findings: Suggestion[]; generated_at: string; latency_ms: number }
  | { status: 'failed'; error: string; generated_at: string };

const SYSTEM_PROMPT = `You are a clinical decision-support assistant for an Indian OPD physician. Given the patient's visit reason, active problems, and last few encounters, suggest a STARTER set of diagnostic tests the physician should consider ordering.

You receive:
- visit_reason: the chief complaint as captured by the CCE/nurse
- active_problems: cached Qwen-summarised problem list
- recent_encounters: brief one-line summary of up to 5 past completed encounters
- allowed_catalog: an array of {service_code, display_name, sub_department} the doctor can order

Return STRICT JSON:
{
  "findings": [
    {
      "service_code": "<MUST be from allowed_catalog>",
      "rationale": "<one-line clinical reason, ≤120 chars>",
      "confidence": 0.5–0.95
    }
  ]
}

Rules:
- 3–8 findings, ordered most → least relevant.
- Only suggest tests in allowed_catalog. If nothing fits, return an empty findings array.
- Skip tests the recent_encounters show were already ordered very recently for the same indication.
- rationale: plain clinical English, no hedging.
- confidence: 0.85+ for highly indicated (recurrent monitoring of known condition); 0.70+ for likely; 0.50+ for worth considering.
Return ONLY the JSON object. No markdown, no prose.`;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getCurrentUser();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const { id: encounterId } = await ctx.params;
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === '1';

  // 1. Load encounter + context
  const encRes = await pool.query<{
    id: string;
    patient_id: string;
    intake_visit_reason: string | null;
    chief_complaint_text: string | null;
    ai_suggested_orders: CachedPayload | null;
    ai_suggested_orders_context_hash: string | null;
  }>(
    `SELECT id, patient_id, intake_visit_reason, chief_complaint_text,
            ai_suggested_orders, ai_suggested_orders_context_hash
     FROM encounters WHERE id = $1 LIMIT 1`,
    [encounterId],
  );
  if (encRes.rows.length === 0) {
    return NextResponse.json({ ok: false, error: 'encounter_not_found' }, { status: 404 });
  }
  const enc = encRes.rows[0];
  const visitReason = (enc.intake_visit_reason || enc.chief_complaint_text || '').trim();

  // 2. Load active problems + last 5 encounters
  const [problemsRes, recentRes] = await Promise.all([
    pool.query<{ summary: { problems?: string[]; medications?: string[] } | null }>(
      `SELECT summary FROM patient_summaries WHERE patient_id = $1 LIMIT 1`,
      [enc.patient_id],
    ),
    pool.query<{ id: string; encounter_date: string; chief_complaint_text: string | null; impression: string | null }>(
      `SELECT id::text, encounter_date::text, chief_complaint_text, assessment AS impression
       FROM encounters
       WHERE patient_id = $1 AND id != $2 AND status='completed'
       ORDER BY encounter_date DESC LIMIT 5`,
      [enc.patient_id, encounterId],
    ),
  ]);
  const problems = problemsRes.rows[0]?.summary?.problems ?? [];
  const recentEncs = recentRes.rows;

  // 3. Hash + cache check
  const contextHash = createHash('sha256')
    .update(JSON.stringify({ visitReason, problems, recentIds: recentEncs.map((r) => r.id).sort() }))
    .digest('hex')
    .slice(0, 24);

  if (!force && enc.ai_suggested_orders_context_hash === contextHash && enc.ai_suggested_orders) {
    return NextResponse.json({ ok: true, cached: true, payload: enc.ai_suggested_orders });
  }

  // 4. Build allowed_catalog — keyword-relevance scoring then alphabetic fallback
  const keywords = visitReason.toLowerCase().split(/\W+/).filter((w) => w.length >= 3);
  // Pull top 200 lab + imaging + cardiology tests scored by keyword overlap.
  const { rows: catalog } = await pool.query<{
    service_code: string;
    display_name: string;
    sub_department: string;
    modality: Suggestion['modality'];
    score: number;
  }>(
    `WITH scored AS (
       SELECT service_code, display_name, sub_department, modality,
              COALESCE((
                SELECT SUM(
                  CASE WHEN LOWER(display_name) LIKE '%' || k || '%' THEN 3 ELSE 0 END +
                  CASE WHEN LOWER(sub_department) LIKE '%' || k || '%' THEN 2 ELSE 0 END +
                  CASE WHEN EXISTS (SELECT 1 FROM unnest(synonyms) s WHERE LOWER(s) LIKE '%' || k || '%') THEN 2 ELSE 0 END
                )::int
                FROM unnest($1::text[]) AS k
              ), 0) AS score
       FROM diagnostic_catalog
       WHERE is_active = true
         AND modality IN ('lab','imaging','cardiology')
         AND 'OP' = ANY(patient_types)
     )
     SELECT * FROM scored
     ORDER BY score DESC, display_name ASC
     LIMIT 200`,
    [keywords.length > 0 ? keywords : ['']],
  );

  // 5. Call Qwen
  const userMessage = JSON.stringify({
    visit_reason: visitReason || '(none captured)',
    active_problems: problems,
    recent_encounters: recentEncs.map((r) => ({
      date: r.encounter_date,
      cc: (r.chief_complaint_text || '').slice(0, 100),
      impression: (r.impression || '').slice(0, 200),
    })),
    allowed_catalog: catalog.map((c) => ({
      service_code: c.service_code,
      display_name: c.display_name,
      sub_department: c.sub_department,
    })),
  });

  let payload: CachedPayload;
  try {
    const t0 = Date.now();
    const result = await qwenJson<{ findings: Array<{ service_code: string; rationale: string; confidence: number }> }>(
      SYSTEM_PROMPT,
      userMessage,
      { timeoutMs: 60_000 },
    );
    const latency_ms = Date.now() - t0;

    // Provenance filter: only allow service_codes that were in the sent allowed_catalog
    const allowedSet = new Set(catalog.map((c) => c.service_code));
    const catalogByCode = new Map(catalog.map((c) => [c.service_code, c]));
    const cleanFindings: Suggestion[] = (result.json.findings ?? [])
      .filter((f) => f.service_code && allowedSet.has(f.service_code))
      .slice(0, 8)
      .map((f) => {
        const c = catalogByCode.get(f.service_code)!;
        return {
          service_code: f.service_code,
          display_name: c.display_name,
          sub_department: c.sub_department,
          modality: c.modality,
          rationale: (f.rationale ?? '').slice(0, 140),
          confidence: Math.max(0, Math.min(1, Number(f.confidence) || 0.5)),
        };
      });

    payload = {
      status: 'ok',
      findings: cleanFindings,
      generated_at: new Date().toISOString(),
      latency_ms,
    };
  } catch (e) {
    const msg = e instanceof QwenError
      ? `Qwen ${e.kind}${e.status ? ` (${e.status})` : ''}`
      : e instanceof Error ? e.message : String(e);
    payload = {
      status: 'failed',
      error: msg.slice(0, 200),
      generated_at: new Date().toISOString(),
    };
  }

  // 6. Cache
  await pool.query(
    `UPDATE encounters
     SET ai_suggested_orders = $2::jsonb,
         ai_suggested_orders_generated_at = NOW(),
         ai_suggested_orders_context_hash = $3
     WHERE id = $1`,
    [encounterId, JSON.stringify(payload), contextHash],
  );

  return NextResponse.json({ ok: true, cached: false, payload });
}
