/**
 * Edge middleware — gates protected pages on session cookie validity.
 *
 * Important Next.js gotcha (we learned this on EHRC and Even-ELO): the
 * middleware file MUST live at src/middleware.ts in src/-layout projects.
 * A root-level middleware.ts in a src/ project is silently ignored by
 * Next.js and the gate disappears.
 *
 * Edge runtime can't import `next/headers`, so we verify the session JWT
 * inline using `jose` against the cookie value.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

const SESSION_COOKIE = 'opd_session';

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not configured');
  return new TextEncoder().encode(s);
}

async function isAuthed(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload.purpose === 'session' && typeof payload.email === 'string';
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const authed = await isAuthed(token);

  if (!authed) {
    const url = req.nextUrl.clone();
    url.pathname = '/auth/login';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

// Protect /dashboard and everything under it. /auth/* and /api/auth/* stay
// public so the magic-link flow can resolve.
export const config = {
  matcher: ['/dashboard/:path*'],
};
