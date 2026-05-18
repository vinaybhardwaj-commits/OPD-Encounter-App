'use server';

/**
 * Server actions for the dashboard queue.
 *
 * Server actions are POST-on-submit by design — agents/crawlers can't
 * accidentally start an encounter just by following a hover-link, which
 * is the failure mode if we did the same as a GET handler.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getCurrentDoctor } from '@/lib/auth';
import { startEncounterForPatient } from '@/lib/encounters';

export async function startEncounter(formData: FormData) {
  const session = await getCurrentDoctor();
  if (!session) redirect('/auth/login');

  const patient_id = String(formData.get('patient_id') ?? '');
  if (!patient_id) throw new Error('missing_patient_id');

  const { encounter_id } = await startEncounterForPatient({
    patient_id,
    doctor_email: session.email,
  });

  revalidatePath('/dashboard');
  redirect(`/dashboard/encounters/${encounter_id}`);
}
