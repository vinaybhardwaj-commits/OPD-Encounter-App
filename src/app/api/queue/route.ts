/**
 * GET /api/queue
 *
 * The OPD doctor's queue for today. Returns four buckets ordered by
 * what's most actionable, matching design doc §4.1:
 *
 *   ready_to_resume  (green) — patient returned from diagnostics
 *   waiting          (white) — patient not yet seen by the doctor
 *   at_diagnostics   (amber) — encounter paused, test pending
 *   completed        (dim)   — finished today, archive view
 *
 * "Waiting" = patient row with NO encounter for the current doctor today.
 * Other buckets = encounter rows for the current doctor with matching
 * status, ordered by activity time. Active-encounter rows (the one the
 * doctor is currently in) sit in `waiting` visually because the design
 * collapses "in progress" into the same column the doctor came from.
 *
 * Returns 401 if no valid session.
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { getCurrentDoctor } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type QueueCard = {
  patient_id: string;
  mrn: string;
  name: string;
  age_years: number;
  sex: 'M' | 'F' | 'O';
  phone_e164: string | null;
  known_allergies: string | null;
  encounter_id: string | null;
  encounter_number: string | null;
  status: 'waiting' | 'active' | 'paused_diagnostics' | 'ready_to_resume' | 'completed';
  chief_complaint_text: string | null;
  pending_diagnostic_test: string | null;
  started_at: string | null;
  completed_at: string | null;
};

export async function GET() {
  const doctor = await getCurrentDoctor();
  if (!doctor) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const { rows: doctorRows } = await pool.query<{ id: string }>(
      'SELECT id FROM doctors WHERE lower(email) = $1 LIMIT 1',
      [doctor.email.toLowerCase()],
    );
    const doctorId = doctorRows[0]?.id;
    if (!doctorId) {
      return NextResponse.json({ ok: false, error: 'doctor_not_seeded' }, { status: 403 });
    }

    // Patients with NO encounter today for this doctor = "waiting".
    // Patients WITH an encounter today = whatever the encounter status is.
    // ALL patients in the system surface here for the demo; in production
    // the queue feed comes from Pulse and only includes today's
    // appointments.
    const { rows } = await pool.query<QueueCard>(
      `
      SELECT
        p.id AS patient_id,
        p.mrn,
        p.name,
        p.age_years,
        p.sex,
        p.phone_e164,
        p.known_allergies,
        e.id AS encounter_id,
        e.encounter_number,
        COALESCE(e.status::text, 'waiting') AS status,
        e.chief_complaint_text,
        e.pending_diagnostic_test,
        e.started_at,
        e.completed_at
      FROM patients p
      LEFT JOIN LATERAL (
        SELECT *
        FROM encounters
        WHERE patient_id = p.id
          AND doctor_id = $1
          AND encounter_date = CURRENT_DATE
        ORDER BY started_at DESC
        LIMIT 1
      ) e ON TRUE
      ORDER BY
        CASE COALESCE(e.status::text, 'waiting')
          WHEN 'ready_to_resume' THEN 0
          WHEN 'active' THEN 1
          WHEN 'waiting' THEN 2
          WHEN 'paused_diagnostics' THEN 3
          WHEN 'completed' THEN 4
          ELSE 5
        END,
        e.started_at DESC NULLS LAST,
        p.name ASC
      `,
      [doctorId],
    );

    // Bucket into 4 lanes
    const ready_to_resume: QueueCard[] = [];
    const waiting: QueueCard[] = [];
    const at_diagnostics: QueueCard[] = [];
    const completed: QueueCard[] = [];
    for (const r of rows) {
      if (r.status === 'ready_to_resume') ready_to_resume.push(r);
      else if (r.status === 'paused_diagnostics') at_diagnostics.push(r);
      else if (r.status === 'completed') completed.push(r);
      else waiting.push(r); // includes 'waiting' (no encounter) + 'active'
    }

    return NextResponse.json({
      ok: true,
      doctor: { email: doctor.email, id: doctorId },
      counts: {
        ready_to_resume: ready_to_resume.length,
        waiting: waiting.length,
        at_diagnostics: at_diagnostics.length,
        completed: completed.length,
        total: rows.length,
      },
      ready_to_resume,
      waiting,
      at_diagnostics,
      completed,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: 'query_failed', detail: msg.slice(0, 200) },
      { status: 500 },
    );
  }
}
