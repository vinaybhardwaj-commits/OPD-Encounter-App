'use server';

/**
 * Server actions for /reception (CCE workstation).
 *
 * actionMarkDiagnosticReady — CCE clicks "✓ Result ready" on a paused
 *   encounter when the lab returns the result. Flips status from
 *   paused_diagnostics → ready_to_resume so the doctor sees it in the
 *   "Ready" lane. (v1 had this in /admin/demo-controls; v2 puts it on
 *   the CCE's workstation where it belongs.)
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { pool } from '@/lib/db';

async function requireSession(): Promise<void> {
  const session = await getCurrentUser();
  if (!session) redirect('/auth/login');
}

export async function actionMarkDiagnosticReady(formData: FormData) {
  await requireSession();
  const encounterId = String(formData.get('encounter_id') ?? '');
  if (!encounterId) return;
  await pool.query(
    `UPDATE encounters
        SET status = 'ready_to_resume',
            updated_at = NOW()
      WHERE id = $1
        AND status = 'paused_diagnostics'`,
    [encounterId],
  );
  revalidatePath('/reception');
  // Also notify the doctor's dashboard if they're looking at it
  revalidatePath('/dashboard');
}
