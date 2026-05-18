'use server';

/**
 * Server actions for /admin/demo-controls.
 *
 * Every action revalidates /dashboard and /admin/demo-controls so the
 * queue + status block reflect changes immediately. Failures don't
 * throw to the client — they return null and the page reads the latest
 * state on revalidation. (Hard failures will surface in the server log.)
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCurrentDoctor } from '@/lib/auth';
import { pool } from '@/lib/db';
import { notifyRoom } from '@/lib/queueNotify';
import { recomputePatientSummary } from '@/lib/patient-summary';
import {
  resetTodaysEncounters,
  addWalkInPatient,
  markDiagnosticReady,
} from '@/lib/seed';

async function requireSession(): Promise<string> {
  const session = await getCurrentDoctor();
  if (!session) {
    redirect('/auth/login');
  }
  return session.email;
}

function bust() {
  revalidatePath('/admin/demo-controls');
  revalidatePath('/dashboard');
}

export async function actionReset() {
  const email = await requireSession();
  await resetTodaysEncounters(email);
  // Broad bus: every watcher refreshes since the entire day was reset.
  await notifyRoom(null, `demo_reset`);
  bust();
}

export async function actionAddWalkIn() {
  await requireSession();
  await addWalkInPatient();
  await notifyRoom(null, `demo_walk_in`);
  bust();
}

export async function actionMarkReady(formData: FormData) {
  const email = await requireSession();
  const encId = String(formData.get('encounter_id') ?? '');
  if (!encId) return;
  await markDiagnosticReady(encId, email);
  // Look up room for the targeted notify (markDiagnosticReady doesn't
  // return it). One-shot pg_notify, swallows on failure.
  const { rows } = await pool.query<{ room_id: string | null }>(
    `SELECT room_id FROM encounters WHERE id = $1 LIMIT 1`,
    [encId],
  );
  await notifyRoom(rows[0]?.room_id ?? null, `lab_ready:${encId}`);
  bust();
}

// ---------------------------------------------------------------------------
// PH.1.3 — Backfill Qwen summaries
// ---------------------------------------------------------------------------

/**
 * Find every patient with ≥1 completed encounter that does NOT have a
 * `fresh` summary row and recompute it sequentially. Runs at the
 * route-segment maxDuration (300s on Vercel Pro) so the user can fire
 * one click and walk through the lot. If 300s runs out before the
 * batch finishes, the user clicks again — already-fresh rows are
 * skipped so it's idempotent.
 *
 * Behaviour:
 *   - Cap at BATCH_LIMIT eligible patients per click to keep latency
 *     predictable. The page nags the user to click again until 0 remain.
 *   - Each patient runs through recomputePatientSummary, which writes
 *     its own audit row.
 *   - Returns nothing — the page re-reads counts after revalidation.
 */
const BACKFILL_BATCH_LIMIT = 6; // ~5min worst case at warm-Qwen latencies

export async function actionBackfillSummaries() {
  const email = await requireSession();

  // Grab the doctor row so audit rows are attributed.
  const { rows: docRows } = await pool.query<{ id: string }>(
    `SELECT id FROM doctors WHERE lower(email) = lower($1) LIMIT 1`,
    [email],
  );
  const doctorId = docRows[0]?.id ?? null;

  // Eligible = has ≥1 completed encounter AND no fresh summary.
  const { rows: eligible } = await pool.query<{ id: string }>(
    `SELECT DISTINCT e.patient_id AS id
       FROM encounters e
       LEFT JOIN patient_summaries s ON s.patient_id = e.patient_id
      WHERE e.status = 'completed'
        AND (s.status IS NULL OR s.status <> 'fresh')
      ORDER BY e.patient_id
      LIMIT $1`,
    [BACKFILL_BATCH_LIMIT],
  );

  for (const row of eligible) {
    // Sequential — Qwen on V's Mac Mini is single-instance and parallel
    // calls just queue at the model. No reason to over-fan-out.
    await recomputePatientSummary({ patientId: row.id, doctorId });
  }

  bust();
}
