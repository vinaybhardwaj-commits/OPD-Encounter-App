/**
 * GET /api/patients/search?q=<query>
 *
 * Trigram-style autocomplete over patients.name + patients.mrn for the
 * PH.5 global search bar.
 *
 * Auth: signed-in doctor session.
 *
 * Returns up to 8 matches ordered by:
 *   1. Exact MRN match
 *   2. Name prefix match (case-insensitive)
 *   3. Anywhere-substring match
 *
 * Cheap LIKE-based scan — 25 seed patients today, will scale to a few
 * thousand without trigram indexes. PH.6+ can add pg_trgm + GIN if
 * volume warrants.
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getCurrentDoctor } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Row = {
  id: string;
  mrn: string;
  name: string;
  age_years: number;
  sex: 'M' | 'F' | 'O' | null;
  rank: number;
};

export async function GET(req: Request) {
  const session = await getCurrentDoctor();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  if (q.length < 2) {
    return NextResponse.json({ ok: true, matches: [] });
  }

  const ilikeAny = `%${q}%`;
  const ilikePrefix = `${q}%`;
  const lowerQ = q.toLowerCase();

  const { rows } = await pool.query<Row>(
    `SELECT id, mrn, name, age_years, sex,
            CASE
              WHEN lower(mrn) = $3 THEN 0
              WHEN lower(name) LIKE $2 THEN 1
              WHEN lower(name) LIKE $1 OR lower(mrn) LIKE $1 THEN 2
              ELSE 3
            END AS rank
       FROM patients
      WHERE lower(name) LIKE $1
         OR lower(mrn) LIKE $1
      ORDER BY rank ASC, name ASC
      LIMIT 8`,
    [ilikeAny.toLowerCase(), ilikePrefix.toLowerCase(), lowerQ],
  );

  return NextResponse.json({
    ok: true,
    matches: rows.map((r) => ({
      id: r.id,
      mrn: r.mrn,
      name: r.name,
      age_years: r.age_years,
      sex: r.sex,
    })),
  });
}
