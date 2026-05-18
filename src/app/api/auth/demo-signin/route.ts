/**
 * POST /api/auth/demo-signin
 *
 * One-click sign-in for the demo. Picks the first seeded doctor (V) and
 * issues a session cookie without the magic-link round-trip. Gated by
 * `DEMO_MODE` env var (defaults to true if unset; flipped to 'false' on
 * production hardening, at which point this endpoint returns 403 and
 * the button on /auth/login disappears).
 *
 * Magic-link auth is left in place for when DNS-verified Resend +
 * real pilot doctors come online — this is just the demo bypass.
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { signSession, setSessionCookie } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (process.env.DEMO_MODE === 'false') {
    return NextResponse.json(
      { ok: false, error: 'demo_mode_disabled' },
      { status: 403 },
    );
  }

  // Pick V if present (first-class demo doctor), otherwise the first
  // seeded row. Keeps the endpoint useful even if V's email gets renamed.
  const { rows } = await pool.query<{ email: string; name: string }>(
    `SELECT email, name FROM doctors
     ORDER BY (lower(email) = 'vinay.bhardwaj@even.in') DESC, created_at ASC
     LIMIT 1`,
  );
  const doctor = rows[0];
  if (!doctor) {
    return NextResponse.json(
      { ok: false, error: 'no_doctor_seeded' },
      { status: 500 },
    );
  }

  const token = await signSession(doctor.email);
  await setSessionCookie(token);

  const origin = new URL(req.url).origin;
  return NextResponse.redirect(`${origin}/dashboard`, { status: 303 });
}
