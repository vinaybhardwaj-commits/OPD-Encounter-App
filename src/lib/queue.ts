/**
 * Shared queue fetcher — used by both the JSON API (/api/queue) and the
 * server-rendered queue page (/dashboard). One source of truth for the
 * SQL + bucketing keeps the two views from drifting.
 */
import { pool } from '@/lib/db';

export type QueueStatus =
  | 'waiting'
  | 'active'
  | 'paused_diagnostics'
  | 'ready_to_resume'
  | 'completed';

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
  status: QueueStatus;
  chief_complaint_text: string | null;
  pending_diagnostic_test: string | null;
  started_at: string | null;
  completed_at: string | null;
};

export type DoctorQueue = {
  doctor: { id: string; email: string; name: string };
  ready_to_resume: QueueCard[];
  waiting: QueueCard[];
  at_diagnostics: QueueCard[];
  completed: QueueCard[];
};

/**
 * Returns null if the email isn't seeded as a doctor.
 *
 * The query is one round-trip — patients LEFT JOIN LATERAL to their most
 * recent encounter today for this doctor. Patients with no encounter
 * default to status='waiting'. Active encounters are bucketed with
 * waiting visually (per design doc §4.1).
 */
export async function getQueueForDoctor(
  email: string,
): Promise<DoctorQueue | null> {
  const { rows: doctorRows } = await pool.query<{
    id: string;
    email: string;
    name: string;
  }>(
    'SELECT id, email, name FROM doctors WHERE lower(email) = $1 LIMIT 1',
    [email.trim().toLowerCase()],
  );
  const doctor = doctorRows[0];
  if (!doctor) return null;

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
    [doctor.id],
  );

  const ready_to_resume: QueueCard[] = [];
  const waiting: QueueCard[] = [];
  const at_diagnostics: QueueCard[] = [];
  const completed: QueueCard[] = [];
  for (const r of rows) {
    if (r.status === 'ready_to_resume') ready_to_resume.push(r);
    else if (r.status === 'paused_diagnostics') at_diagnostics.push(r);
    else if (r.status === 'completed') completed.push(r);
    else waiting.push(r);
  }

  return {
    doctor,
    ready_to_resume,
    waiting,
    at_diagnostics,
    completed,
  };
}
