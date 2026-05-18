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
  bust();
}

export async function actionAddWalkIn() {
  await requireSession();
  await addWalkInPatient();
  bust();
}

export async function actionMarkReady(formData: FormData) {
  const email = await requireSession();
  const encId = String(formData.get('encounter_id') ?? '');
  if (!encId) return;
  await markDiagnosticReady(encId, email);
  bust();
}
