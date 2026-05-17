/**
 * Magic-link auth for OPD-Encounter-App.
 *
 * Two JWTs, both HS256 signed with JWT_SECRET:
 *   1. Magic-link token  — 15-minute TTL, embedded in the emailed link.
 *      Validated by /api/auth/callback before issuing a session.
 *   2. Session cookie    — 30-day TTL, httpOnly + secure + sameSite=lax.
 *      Read by middleware.ts to gate protected pages.
 *
 * Stateless on purpose: M0.4 is the auth shell, not the doctor system. The
 * doctors table arrives in M0.5 with the rest of the demo schema, at which
 * point the allowlist moves from ALLOWED_DOCTOR_EMAILS into the table and
 * the session JWT picks up a doctor_id claim.
 */
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';

const SESSION_COOKIE = 'opd_session';
const SESSION_TTL_DAYS = 30;
const MAGIC_LINK_TTL_MIN = 15;

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not configured');
  return new TextEncoder().encode(s);
}

// -------- magic link --------

type MagicPayload = JWTPayload & { email: string; purpose: 'magic_link' };

export async function signMagicLink(email: string): Promise<string> {
  return new SignJWT({ email, purpose: 'magic_link' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${MAGIC_LINK_TTL_MIN}m`)
    .sign(secret());
}

export async function verifyMagicLink(
  token: string,
): Promise<{ email: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    const p = payload as MagicPayload;
    if (p.purpose !== 'magic_link' || !p.email) return null;
    return { email: p.email };
  } catch {
    return null;
  }
}

// -------- session --------

export type SessionClaims = JWTPayload & {
  email: string;
  purpose: 'session';
};

export async function signSession(email: string): Promise<string> {
  return new SignJWT({ email, purpose: 'session' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .sign(secret());
}

export async function verifySession(
  token: string | undefined,
): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    const p = payload as SessionClaims;
    if (p.purpose !== 'session' || !p.email) return null;
    return p;
  } catch {
    return null;
  }
}

// -------- cookie helpers (Next.js cookies()) --------

import { cookies } from 'next/headers';

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

export async function setSessionCookie(token: string): Promise<void> {
  const c = await cookies();
  c.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const c = await cookies();
  c.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export async function getCurrentDoctor(): Promise<SessionClaims | null> {
  const c = await cookies();
  return verifySession(c.get(SESSION_COOKIE)?.value);
}

// -------- allowlist --------

export function isAllowedEmail(email: string): boolean {
  const list = (process.env.ALLOWED_DOCTOR_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}
