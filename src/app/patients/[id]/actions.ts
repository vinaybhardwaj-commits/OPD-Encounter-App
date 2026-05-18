'use server';

/**
 * Server actions for /patients/[id].
 *
 * The Recompute button reruns the Qwen summarisation pass for the patient,
 * upserts patient_summaries, and writes a qwen_call_audit row. Sits at
 * page.maxDuration (300s, set on the patient page) so the doctor can
 * wait through one cold-start (~47s) without a timeout.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCurrentDoctor } from '@/lib/auth';
import { pool } from '@/lib/db';
import { recomputePatientSummary } from '@/lib/patient-summary';

async function requireDoctor(): Promise<{ email: string; id: string | null }> {
  const session = await getCurrentDoctor();
  if (!session) {
    redirect('/auth/login');
  }
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM doctors WHERE lower(email) = lower($1) LIMIT 1`,
    [session.email],
  );
  return { email: session.email, id: rows[0]?.id ?? null };
}

export async function actionRecompute(formData: FormData) {
  const doc = await requireDoctor();
  const patientId = String(formData.get('patient_id') ?? '');
  if (!patientId) return;
  await recomputePatientSummary({ patientId, doctorId: doc.id });
  revalidatePath(`/patients/${patientId}`);
}
