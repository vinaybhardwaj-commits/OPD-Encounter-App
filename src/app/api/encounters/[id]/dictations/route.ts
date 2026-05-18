/**
 * Section dictation endpoint pair.
 *
 * GET  /api/encounters/[id]/dictations  — list dictations for this encounter
 * POST /api/encounters/[id]/dictations  — record a new dictation marker
 *
 * M3.3 scope: capture the doctor's *intent* to dictate at a specific
 * section (chief_complaint, exam_findings, assessment, prescription).
 * The row records the section + duration_seconds; audio_blob_url and
 * transcript_text stay NULL until Sprint 5 wires the audio + Deepgram
 * pipeline.
 *
 * Auth: encounter must belong to the signed-in doctor. Completed
 * encounters can still receive dictations (read-only assessment can be
 * voice-annotated later in v2; demo doesn't need to gate this).
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getCurrentDoctor } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_SECTIONS = new Set([
  'chief_complaint',
  'exam_findings',
  'assessment',
  'prescription',
  'disposition',
]);

async function ownerCheck(encId: string, doctorEmail: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM encounters e
       JOIN doctors d ON d.id = e.doctor_id
       WHERE e.id = $1 AND lower(d.email) = $2
     ) AS exists`,
    [encId, doctorEmail.toLowerCase()],
  );
  return rows[0]?.exists ?? false;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getCurrentDoctor();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await ownerCheck(id, session.email))) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  const { rows } = await pool.query<{
    id: string;
    section: string;
    audio_blob_url: string | null;
    duration_seconds: number;
    transcript_text: string | null;
    created_at: string;
  }>(
    `SELECT id, section, audio_blob_url, duration_seconds, transcript_text, created_at
     FROM section_dictations
     WHERE encounter_id = $1
     ORDER BY created_at DESC`,
    [id],
  );

  return NextResponse.json({ ok: true, dictations: rows });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getCurrentDoctor();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await ownerCheck(id, session.email))) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  let body: { section?: string; duration_seconds?: number };
  try {
    body = (await req.json()) as { section?: string; duration_seconds?: number };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 });
  }
  const section = (body.section ?? '').trim();
  const duration = Math.max(0, Math.min(600, Math.floor(Number(body.duration_seconds) || 0)));
  if (!ALLOWED_SECTIONS.has(section)) {
    return NextResponse.json({ ok: false, error: 'invalid_section' }, { status: 400 });
  }

  const { rows } = await pool.query<{ id: string; created_at: string }>(
    `INSERT INTO section_dictations (encounter_id, section, duration_seconds)
     VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [id, section, duration],
  );

  return NextResponse.json({
    ok: true,
    dictation: { id: rows[0].id, section, duration_seconds: duration, created_at: rows[0].created_at },
  });
}
