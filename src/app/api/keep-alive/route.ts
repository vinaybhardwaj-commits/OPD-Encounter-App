/**
 * GET /api/keep-alive
 *
 * Clinic-hour cron pre-warm for the Qwen tunnel.
 *
 * EHRC's carryover §10 notes a 47s cold-start when the Mac Mini sleeps
 * (Cloudflare Tunnel + Ollama process both wake up). For the OPD app
 * we don't want the doctor to wait that long on the FIRST encounter
 * of the morning — the post-/complete hook keeps Qwen warm during the
 * day, but only once the doctor has finished an encounter. The cron
 * fires every 15 minutes during clinic hours (Mon-Sat) to bridge the
 * gap before the first patient lands.
 *
 * Cron schedule (vercel.json):
 *   "0,15,30,45 7-21 * * 1-6"  → every 15min from 7am-9pm, Mon-Sat
 *
 * Vercel automatically attaches `Authorization: Bearer ${CRON_SECRET}`
 * on cron-triggered requests when CRON_SECRET is configured. We allow
 * either:
 *   - a request bearing that header (the cron path), OR
 *   - any unauthenticated GET (the manual liveness-probe path)
 *
 * because the worst a stray ping can do is keep Qwen warm — same as
 * the intended behaviour.
 *
 * Response: { ok, latency_ms, model, error? }
 */
import { NextResponse } from 'next/server';
import { qwenPing, QWEN_MODEL } from '@/lib/qwen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  const result = await qwenPing();
  return NextResponse.json({
    ok: result.ok,
    latency_ms: result.latency_ms,
    model: QWEN_MODEL,
    error: result.error,
  });
}
