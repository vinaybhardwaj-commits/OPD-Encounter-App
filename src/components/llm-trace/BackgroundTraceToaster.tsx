'use client';

/**
 * src/components/llm-trace/BackgroundTraceToaster.tsx
 *
 * v6.0 — bottom-right corner toaster for autonomous LLM fires that
 * don't have an obvious inline render slot (recomputePatientSummary,
 * suggest-comorbidities-from-history when triggered as a background
 * job, etc.).
 *
 * Decision Q4: trace always, toast only while the doctor is still on
 * the SAME patient/encounter context. Errored summaries trip a sticky
 * variant the next time that patient is opened.
 *
 * Usage:
 *   <BackgroundTraceToaster encounterId={initial.id} />
 *
 * The component subscribes to a small in-memory registry exposed by
 * `lib/llm-trace/background-registry.ts` (sibling file). Any async
 * surface that wants to surface a toast pushes a trace handle into
 * the registry; the toaster renders compact TracePanels for every
 * active trace.
 */

import { useEffect, useState } from 'react';
import TracePanel, { type TraceEvent, type LLMSurface } from './TracePanel';
import { subscribeBackgroundTraces, type BackgroundTrace } from '@/lib/llm-trace/background-registry';

export type BackgroundTraceToasterProps = {
  encounterId?: string;
  patientId?: string;
};

export default function BackgroundTraceToaster({
  encounterId,
  patientId,
}: BackgroundTraceToasterProps) {
  const [traces, setTraces] = useState<BackgroundTrace[]>([]);

  useEffect(() => {
    return subscribeBackgroundTraces((all) => {
      // Filter to the active context — only show toasts tied to the
      // patient/encounter the doctor is currently looking at.
      setTraces(
        all.filter((t) => {
          if (encounterId && t.encounter_id !== encounterId) return false;
          if (patientId && t.patient_id !== patientId) return false;
          return true;
        }),
      );
    });
  }, [encounterId, patientId]);

  if (traces.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[280px] flex-col gap-2">
      {traces.map((t) => (
        <div key={t.id} className="pointer-events-auto rounded-lg shadow-lg">
          <TracePanel
            events={t.events as TraceEvent[]}
            totalMs={t.totalMs}
            traceId={t.id}
            surface={t.surface as LLMSurface}
            compact
          />
        </div>
      ))}
    </div>
  );
}
