/**
 * GET /api/health
 *
 * M0.3 connection-test route. Probes the Neon pool, returns latency in ms,
 * the Postgres server version, and a non-secret echo of which DB host
 * pgbouncer routed us to. Used by uptime probes + sprint smoke tests.
 *
 * Response shape (200):
 *   { ok: true, db: { connected: true, latency_ms, server_version, host_hint }, build, now }
 *
 * On DB failure returns 503 with { ok: false, db: { connected: false, error } }
 * so monitoring can distinguish app-up-but-DB-down from total outage.
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type HealthBody = {
  ok: boolean;
  db: {
    connected: boolean;
    latency_ms?: number;
    server_version?: string;
    host_hint?: string;
    error?: string;
  };
  build: {
    sha: string | null;
    region: string | null;
  };
  now: string;
};

export async function GET() {
  const t0 = Date.now();
  let body: HealthBody;

  try {
    const result = await pool.sql`select version() as version, inet_server_addr()::text as host`;
    const latency_ms = Date.now() - t0;
    const row = (result.rows[0] || {}) as { version?: string; host?: string };
    // server_version like "PostgreSQL 17.x on aarch64-unknown-linux-gnu ..." — keep first 50 chars
    const server_version = (row.version || '').slice(0, 50);
    body = {
      ok: true,
      db: {
        connected: true,
        latency_ms,
        server_version,
        host_hint: row.host ?? undefined,
      },
      build: {
        sha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
        region: process.env.VERCEL_REGION ?? null,
      },
      now: new Date().toISOString(),
    };
    return NextResponse.json(body, { status: 200 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    body = {
      ok: false,
      db: { connected: false, error: msg.slice(0, 200) },
      build: {
        sha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
        region: process.env.VERCEL_REGION ?? null,
      },
      now: new Date().toISOString(),
    };
    return NextResponse.json(body, { status: 503 });
  }
}
