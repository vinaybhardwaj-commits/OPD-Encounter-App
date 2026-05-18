/**
 * POST /api/internal/recompute-summary?patient_id=<uuid>
 *
 * Runs the Qwen summarisation pass for a patient and upserts the result
 * into `patient_summaries`. Writes an audit row to `qwen_call_audit`
 * for every call regardless of outcome.
 *
 * Authentication:
 *   - Authed doctor session OR
 *   - `x-internal-secret: <INTERNAL_API_SECRET>` header
 *
 * The shared-secret path exists so that PH.1.3's post-/complete hook
 * and the keep-alive cron can call this endpoint server-to-server
 * without going through the cookie flow. For PH.1.2 manual fire-test
 * we use the session-cookie path.
 *
 * Behaviour:
 *   - patient_id missing or unknown → 400 / 404
 *   - 0 completed encounters → still computes (cold-start case); Qwen
 *     gets an empty encounter list and returns the "no prior history"
 *     baseline summary
 *   - Qwen failure → row written with status='failed', fail_reason set,
 *     audit row 'parse_error' | 'timeout' | 'schema_violation'.
 *     HTTP response is 200 with { ok:false, reason } so the caller
 *     (post-/complete hook) can swallow it.
 *
 * No background queue — the endpoint blocks on Qwen. Caller decides
 * whether to await or fire-and-forget.
 */

import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { pool } from '@/lib/db';
import { getCurrentDoctor } from '@/lib/auth';
import { qwenJson, QwenError, QWEN_MODEL } from '@/lib/qwen';
import {
  buildSummaryInput,
  buildSummaryUserMessage,
  SUMMARY_SYSTEM_PROMPT,
  validateSummary,
} from '@/lib/patient-summary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function isAuthorized(req: Request): Promise<{ ok: boolean; doctorId: string | null }> {
  // Path 1: internal shared secret (server-to-server)
  const headerSecret = req.headers.get('x-internal-secret');
  const envSecret = process.env.INTERNAL_API_SECRET;
  if (headerSecret && envSecret && headerSecret === envSecret) {
    return { ok: true, doctorId: null };
  }
  // Path 2: signed-in doctor session
  const session = await getCurrentDoctor();
  if (!session) return { ok: false, doctorId: null };
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM doctors WHERE lower(email) = lower($1) LIMIT 1`,
    [session.email],
  );
  return { ok: true, doctorId: rows[0]?.id ?? null };
}

async function writeAudit(args: {
  patient_id: string;
  doctor_id: string | null;
  prompt: string;
  output: string;
  latency_ms: number | null;
  result: 'success' | 'parse_error' | 'timeout' | 'schema_violation' | 'http_error' | 'network';
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO qwen_call_audit
         (patient_id, doctor_id, prompt_hash, output_hash, qwen_model, qwen_latency_ms, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        args.patient_id,
        args.doctor_id,
        sha256(args.prompt),
        sha256(args.output ?? ''),
        QWEN_MODEL,
        args.latency_ms,
        args.result,
      ],
    );
  } catch {
    // Swallow audit failures — they should never break the primary path.
  }
}

export async function POST(req: Request) {
  const auth = await isAuthorized(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const patient_id = url.searchParams.get('patient_id');
  if (!patient_id) {
    return NextResponse.json({ ok: false, error: 'patient_id required' }, { status: 400 });
  }

  const bundle = await buildSummaryInput(patient_id);
  if (!bundle) {
    return NextResponse.json({ ok: false, error: 'patient_not_found' }, { status: 404 });
  }

  // Mark as computing for observability — a subsequent GET while Qwen is
  // running will see status='computing'. Idempotent.
  await pool.query(
    `INSERT INTO patient_summaries
       (patient_id, summary, source_encounter_count, source_window_start, source_window_end, qwen_model, status)
     VALUES ($1, '{}'::jsonb, $2, $3, $4, $5, 'computing')
     ON CONFLICT (patient_id) DO UPDATE SET status='computing'`,
    [patient_id, bundle.encounters.length, bundle.window_start, bundle.window_end, QWEN_MODEL],
  );

  const userMessage = buildSummaryUserMessage(bundle);

  // Call Qwen.
  let qwenLatency: number | null = null;
  try {
    const result = await qwenJson<unknown>(SUMMARY_SYSTEM_PROMPT, userMessage);
    qwenLatency = result.latency_ms;

    const v = validateSummary(result.json);
    if (!v.ok) {
      await writeAudit({
        patient_id,
        doctor_id: auth.doctorId,
        prompt: userMessage,
        output: result.raw,
        latency_ms: qwenLatency,
        result: 'schema_violation',
      });
      await pool.query(
        `UPDATE patient_summaries
            SET status='failed', fail_reason=$2, qwen_latency_ms=$3
          WHERE patient_id=$1`,
        [patient_id, `schema_violation:${v.reason}`, qwenLatency],
      );
      return NextResponse.json({ ok: false, reason: 'schema_violation', detail: v.reason });
    }

    await pool.query(
      `INSERT INTO patient_summaries
         (patient_id, summary, source_encounter_count, source_window_start,
          source_window_end, qwen_model, qwen_latency_ms, computed_at, status, fail_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'fresh', NULL)
       ON CONFLICT (patient_id) DO UPDATE SET
         summary = EXCLUDED.summary,
         source_encounter_count = EXCLUDED.source_encounter_count,
         source_window_start = EXCLUDED.source_window_start,
         source_window_end = EXCLUDED.source_window_end,
         qwen_model = EXCLUDED.qwen_model,
         qwen_latency_ms = EXCLUDED.qwen_latency_ms,
         computed_at = NOW(),
         status = 'fresh',
         fail_reason = NULL`,
      [
        patient_id,
        JSON.stringify(v.value),
        bundle.encounters.length,
        bundle.window_start,
        bundle.window_end,
        QWEN_MODEL,
        qwenLatency,
      ],
    );

    await writeAudit({
      patient_id,
      doctor_id: auth.doctorId,
      prompt: userMessage,
      output: result.raw,
      latency_ms: qwenLatency,
      result: 'success',
    });

    return NextResponse.json({
      ok: true,
      patient_id,
      latency_ms: qwenLatency,
      encounter_count: bundle.encounters.length,
      window: { start: bundle.window_start, end: bundle.window_end },
    });
  } catch (e: unknown) {
    const isQwenErr = e instanceof QwenError;
    const auditResult: 'parse_error' | 'timeout' | 'http_error' | 'network' = isQwenErr
      ? e.kind === 'timeout'
        ? 'timeout'
        : e.kind === 'http'
          ? 'http_error'
          : e.kind === 'parse_error'
            ? 'parse_error'
            : 'network'
      : 'network';
    const reason = e instanceof Error ? e.message : 'unknown';

    await writeAudit({
      patient_id,
      doctor_id: auth.doctorId,
      prompt: userMessage,
      output: '',
      latency_ms: qwenLatency,
      result: auditResult,
    });
    await pool.query(
      `UPDATE patient_summaries
          SET status='failed', fail_reason=$2, qwen_latency_ms=$3
        WHERE patient_id=$1`,
      [patient_id, `${auditResult}:${reason.slice(0, 200)}`, qwenLatency],
    );

    return NextResponse.json({ ok: false, reason: auditResult, detail: reason });
  }
}
