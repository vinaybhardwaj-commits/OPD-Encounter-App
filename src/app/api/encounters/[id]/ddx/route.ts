/**
 * POST /api/encounters/[id]/ddx
 *
 * v2.2.2 — Auto-DDx on Submit click (PRD Round 5 #12).
 *
 * Pulls the encounter's clinical context (CC chips + free-text + exam +
 * vitals + assessment) plus the patient's cached Qwen summary
 * (problems, meds, allergies) plus the last 5 completed encounters
 * (de-identified IDs only — Qwen sees free-text but provenance is by
 * encounter UUID).
 *
 * Asks Qwen for a ranked DDx of up to 5 conditions with per-item
 * provenance: which past encounter_ids informed each suggestion.
 *
 * Output written to encounters.ddx_findings (JSONB, migration v21).
 *
 * Auth: encounter doctor or admin.
 *
 * On Qwen failure: persist { status: 'failed', error }; modal shows
 * "DDx unavailable" but Submit is never blocked.
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { qwenJson, QwenError } from '@/lib/qwen';
import { kbRetrieve, type KbChunk } from '@/lib/kb';
import { loadComorbidityContext, comorbidityContextForPrompt } from '@/lib/patient-comorbidity-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

type DdxFinding = {
  condition: string;
  likelihood: 'high' | 'medium' | 'low';
  rationale: string;
  source_encounter_ids: string[];
  /** v3.10.1 — KB chunk indices (1-based) that ground this diagnosis. */
  citation_numbers: number[];
};

type CitationChunk = {
  n: number;
  source: string;
  book: string;
  chapter: string | null;
  section: string | null;
  page: number | null;
  similarity: number;
  text_excerpt: string;
};

type DdxPayload =
  | {
      status: 'ok';
      findings: DdxFinding[];
      /** v3.10.1 — full ordered chunk list. Findings reference by 1-based index. */
      citations: CitationChunk[];
      scanned_at: string;
      latency_ms: number;
      kb_latency_ms?: number;
    }
  | {
      status: 'failed';
      error: string;
      scanned_at: string;
    };

const SYSTEM_PROMPT = `You are a clinical reasoning assistant for an Indian OPD EHR. The doctor has just finished examining a patient and is about to submit an encounter. Provide a brief differential diagnosis to help the doctor sanity-check their assessment.

You receive:
- This encounter's chief complaint chips + free text
- This encounter's exam findings + vitals
- This encounter's working assessment (may be partial)
- The patient's cached problem list + active medications + allergies
- Up to 5 past completed encounters with id + chief complaint + assessment
- v3.10.1: A "kb_context" field with up to 8 numbered clinical reference chunks retrieved from MKSAP, StatPearls, UpToDate, OpenFDA, PubMed, textbooks, and clinical guidelines.

Return STRICT JSON:
{
  "findings": [
    {
      "condition": "<diagnosis name>",
      "likelihood": "high" | "medium" | "low",
      "rationale": "<one short clinical sentence with inline [N] citations to kb_context where N is the 1-based chunk number>",
      "source_encounter_ids": ["<past encounter id that informs this>", ...],
      "citation_numbers": [1, 3]
    }
  ]
}

Rules:
- At most 5 findings, ordered most → least likely.
- Skip findings the doctor has clearly already considered (look at the working assessment).
- DO NOT speculate without evidence. If clinical data is sparse, return fewer findings or none.
- Cite past encounters in source_encounter_ids when a finding is informed by recurrence, prior workup, or chronicity. Empty array when the finding is purely from today's encounter.
- v3.10.1 CITATION RULES:
  - When kb_context supports a finding, embed inline [N] markers in the rationale where N matches the kb_context chunk number (1-indexed).
  - Also list those chunk numbers in citation_numbers: [N, ...] for the diagnosis.
  - If kb_context contains nothing relevant for a finding, leave citation_numbers as [] and skip inline markers — do not invent citations.
- One sentence rationale max. No hedging language.

Return ONLY the JSON object. No prose, no markdown.`;

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getCurrentUser();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  if (session.role !== 'doctor' && session.role !== 'admin') {
    return NextResponse.json({ ok: false, error: 'forbidden_role' }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ ok: false, error: 'bad_id' }, { status: 400 });
  }

  // Load this encounter + patient + ownership check.
  const { rows: encRows } = await pool.query<{
    id: string;
    patient_id: string;
    doctor_email: string;
    chief_complaint_chips: string[] | null;
    chief_complaint_text: string | null;
    exam_findings: string | null;
    vitals: unknown | null;
    assessment_codes: string[] | null;
    assessment_text: string | null;
  }>(
    `SELECT e.id, e.patient_id,
            d.email AS doctor_email,
            e.chief_complaint_chips, e.chief_complaint_text,
            e.exam_findings, e.vitals,
            e.assessment_codes, e.assessment_text
     FROM encounters e
     JOIN doctors d ON d.id = e.doctor_id
     WHERE e.id = $1
     LIMIT 1`,
    [id],
  );
  const enc = encRows[0];
  if (!enc) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  if (
    session.role !== 'admin' &&
    enc.doctor_email.toLowerCase() !== session.email.toLowerCase()
  ) {
    return NextResponse.json({ ok: false, error: 'not_your_encounter' }, { status: 403 });
  }

  // Pull patient summary (cached Qwen problems + meds + allergies).
  const { rows: pRows } = await pool.query<{
    known_allergies: string | null;
    problems_json: { label: string; status?: string }[] | null;
    meds_json:
      | { generic_name?: string; brand_name?: string; dose?: string; status?: string }[]
      | null;
  }>(
    `SELECT
       p.known_allergies,
       ps.summary->'problems' AS problems_json,
       ps.summary->'medications_active' AS meds_json
     FROM patients p
     LEFT JOIN patient_summaries ps ON ps.patient_id = p.id
     WHERE p.id = $1
     LIMIT 1`,
    [enc.patient_id],
  );
  const pctx = pRows[0] ?? {
    known_allergies: null,
    problems_json: null,
    meds_json: null,
  };

  // Last 5 completed encounters for provenance.
  const { rows: pastRows } = await pool.query<{
    id: string;
    encounter_date: string;
    chief_complaint_text: string | null;
    assessment_text: string | null;
  }>(
    `SELECT id, encounter_date::text AS encounter_date,
            chief_complaint_text, assessment_text
     FROM encounters
     WHERE patient_id = $1 AND status = 'completed' AND id <> $2
     ORDER BY encounter_date DESC
     LIMIT 5`,
    [enc.patient_id, id],
  );

  // Compose Qwen input.
  const today = {
    chief_complaint_chips: enc.chief_complaint_chips ?? [],
    chief_complaint_text: enc.chief_complaint_text,
    exam_findings: enc.exam_findings,
    vitals: enc.vitals,
    assessment_codes: enc.assessment_codes ?? [],
    assessment_text: enc.assessment_text,
  };
  const background = {
    active_problems: (pctx.problems_json ?? [])
      .filter((p) => !p.status || p.status === 'active')
      .map((p) => p.label)
      .filter(Boolean),
    active_meds: (pctx.meds_json ?? [])
      .filter((m) => !m.status || m.status === 'active')
      .map((m) => `${m.generic_name || m.brand_name || ''} ${m.dose ?? ''}`.trim())
      .filter(Boolean),
    known_allergies: pctx.known_allergies,
  };
  const past_encounters = pastRows.map((r) => ({
    id: r.id,
    encounter_date: r.encounter_date,
    chief_complaint: r.chief_complaint_text,
    assessment: r.assessment_text,
  }));

  // v3.9.1b — comorbidity-aware prompt context
  const comorbidityCtx = await loadComorbidityContext(enc.patient_id).catch(() => null);

  // v3.10.1 — KB retrieval. Build a clinical query from cc + assessment;
  // HyDE-expand → embed → top-8 chunks from MKSAP/StatPearls/UpToDate/etc.
  // Soft-fail: if KB is unreachable, kbChunks stays empty and DDx degrades
  // to model-knowledge-only (same as pre-v3.10.1 behavior).
  const ddxQuery = [
    today.chief_complaint_text ?? '',
    (today.chief_complaint_chips ?? []).join(' '),
    today.assessment_text ?? '',
    background.active_problems.slice(0, 5).join(' '),
  ].filter(Boolean).join(' · ').slice(0, 1500);

  const kbT0 = Date.now();
  const kbChunks: KbChunk[] = ddxQuery.length >= 5
    ? await kbRetrieve(ddxQuery, { topK: 8, hyde: true, timeoutMs: 25_000 })
    : [];
  const kbLatencyMs = Date.now() - kbT0;

  const kb_context = kbChunks.map((c, i) => ({
    n: i + 1,
    book: c.book,
    chapter: c.chapter,
    section: c.section,
    page: c.page_start,
    text_excerpt: c.text.slice(0, 1200),
  }));

  const userMessage = JSON.stringify({
    today,
    background,
    past_encounters,
    ...(comorbidityCtx ? comorbidityContextForPrompt(comorbidityCtx) : {}),
    kb_context,
  });

  const scanned_at = new Date().toISOString();
  let payload: DdxPayload;
  try {
    const result = await qwenJson<{
      findings?: Array<{
        condition?: string;
        likelihood?: string;
        rationale?: string;
        source_encounter_ids?: unknown;
        citation_numbers?: unknown;
      }>;
    }>(SYSTEM_PROMPT, userMessage, { timeoutMs: 90_000 });

    const validIds = new Set(past_encounters.map((p) => p.id));
    const maxCitationN = kbChunks.length;
    const findings: DdxFinding[] = [];
    for (const f of result.json.findings ?? []) {
      const condition = String(f.condition ?? '').trim();
      const likelihood = normalizeLikelihood(f.likelihood);
      if (!condition || !likelihood) continue;
      const srcIds = Array.isArray(f.source_encounter_ids)
        ? f.source_encounter_ids
            .map(String)
            .filter((s): s is string => validIds.has(s))
        : [];
      const citNums = Array.isArray(f.citation_numbers)
        ? Array.from(new Set(
            f.citation_numbers
              .map((n) => Number(n))
              .filter((n) => Number.isFinite(n) && n >= 1 && n <= maxCitationN),
          )).sort((a, b) => a - b)
        : [];
      findings.push({
        condition: condition.slice(0, 120),
        likelihood,
        rationale: String(f.rationale ?? '').slice(0, 500),
        source_encounter_ids: srcIds,
        citation_numbers: citNums,
      });
      if (findings.length >= 5) break;
    }

    // v3.10.1 — only include citations actually referenced by at least one
    // finding (keeps the audit log small and avoids tempting the UI to
    // render irrelevant context).
    const referenced = new Set<number>();
    for (const f of findings) for (const n of f.citation_numbers) referenced.add(n);
    const citations: CitationChunk[] = kbChunks
      .map((c, i) => ({
        n: i + 1,
        source: c.source,
        book: c.book,
        chapter: c.chapter,
        section: c.section,
        page: c.page_start,
        similarity: c.similarity,
        text_excerpt: c.text.slice(0, 600),
      }))
      .filter((c) => referenced.has(c.n));

    payload = {
      status: 'ok',
      findings,
      citations,
      scanned_at,
      latency_ms: result.latency_ms,
      kb_latency_ms: kbLatencyMs,
    };
  } catch (e) {
    const msg =
      e instanceof QwenError
        ? `${e.kind}: ${e.message}`
        : e instanceof Error
        ? e.message
        : String(e);
    payload = {
      status: 'failed',
      error: msg.slice(0, 300),
      scanned_at,
    };
  }

  await pool.query(
    `UPDATE encounters SET ddx_findings = $2::jsonb WHERE id = $1`,
    [id, JSON.stringify(payload)],
  );

  return NextResponse.json({ ok: true, ...payload });
}

function normalizeLikelihood(
  s: unknown,
): DdxFinding['likelihood'] | null {
  if (typeof s !== 'string') return null;
  const v = s.toLowerCase().trim();
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return null;
}
