'use client';

/**
 * <DdxOnDemand /> — Polish #1 (v2.2 PRD #12 also said BOTH auto AND
 * on-demand; v2.2 shipped only the auto-on-submit path. This is the
 * doctor-initiated companion).
 *
 * Mounted above the Assessment section in <EncounterEditor>. Tap
 * "Suggest DDx" → fires POST /api/encounters/[id]/ddx → renders the
 * top-5 differential cards inline.
 *
 * Uses the same endpoint + JSONB column (encounters.ddx_findings) as
 * the SubmitConfirmModal auto-DDx. If the doctor already ran DDx at
 * submit-time, the cached findings are pre-loaded (no need to re-fire
 * Qwen).
 *
 * Per always-warn-never-block: this never blocks anything. It's pure
 * cognitive aid.
 */
import { useCallback, useState } from 'react';

type DdxFinding = {
  condition: string;
  likelihood: 'high' | 'medium' | 'low';
  rationale: string;
  source_encounter_ids: string[];
};

type DdxState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; findings: DdxFinding[]; scanned_at: string; latency_ms?: number }
  | { kind: 'failed'; error: string };

export type DdxOnDemandProps = {
  encounterId: string;
  /** Pre-loaded findings from encounters.ddx_findings (server-rendered). */
  initialPayload?:
    | {
        status?: 'ok' | 'failed';
        findings?: DdxFinding[];
        scanned_at?: string;
        latency_ms?: number;
        error?: string;
      }
    | null;
  /** Hidden when encounter is completed. */
  hidden?: boolean;
};

export function DdxOnDemand({
  encounterId,
  initialPayload,
  hidden,
}: DdxOnDemandProps) {
  const seed: DdxState = (() => {
    if (!initialPayload) return { kind: 'idle' };
    if (initialPayload.status === 'failed') {
      return { kind: 'failed', error: initialPayload.error ?? 'unknown' };
    }
    if (initialPayload.status === 'ok' && initialPayload.findings && initialPayload.findings.length > 0) {
      return {
        kind: 'ok',
        findings: initialPayload.findings,
        scanned_at: initialPayload.scanned_at ?? new Date().toISOString(),
        latency_ms: initialPayload.latency_ms,
      };
    }
    return { kind: 'idle' };
  })();

  const [state, setState] = useState<DdxState>(seed);

  const run = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch(`/api/encounters/${encounterId}/ddx`, {
        method: 'POST',
      });
      const j = (await res.json()) as {
        ok?: boolean;
        status?: 'ok' | 'failed';
        findings?: DdxFinding[];
        scanned_at?: string;
        latency_ms?: number;
        error?: string;
      };
      if (j.status === 'failed') {
        setState({ kind: 'failed', error: j.error ?? 'ddx_failed' });
        return;
      }
      setState({
        kind: 'ok',
        findings: j.findings ?? [],
        scanned_at: j.scanned_at ?? new Date().toISOString(),
        latency_ms: j.latency_ms,
      });
    } catch (e) {
      setState({
        kind: 'failed',
        error: e instanceof Error ? e.message : 'network_error',
      });
    }
  }, [encounterId]);

  if (hidden) return null;

  const isOk = state.kind === 'ok';
  const isLoading = state.kind === 'loading';
  const buttonLabel =
    state.kind === 'idle'
      ? 'Suggest DDx'
      : state.kind === 'loading'
      ? 'Asking Qwen…'
      : 'Refresh DDx';

  return (
    <section className="rounded-xl border border-even-ink-200 bg-white p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-even-ink-500">
            Differential diagnosis · Qwen
          </p>
          <p className="text-[10px] text-even-ink-400">
            On-demand sanity check. Auto-DDx also fires on Submit.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={isLoading}
          className="rounded-md bg-even-navy px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-even-navy-700 disabled:opacity-50"
        >
          {buttonLabel}
        </button>
      </div>

      {state.kind === 'failed' && (
        <p className="mt-2 rounded-md bg-even-ink-50 px-3 py-2 text-[11px] text-even-ink-600">
          DDx unavailable ({state.error}). You can keep working — this never
          blocks anything.
        </p>
      )}

      {isLoading && (
        <p className="mt-2 text-[11px] italic text-even-ink-400">
          Pulling patient context + asking Qwen for a ranked DDx…
        </p>
      )}

      {isOk && state.findings.length === 0 && (
        <p className="mt-2 text-[11px] text-even-ink-500">
          Qwen returned 0 findings. Either the chart is too thin to reason
          over, or your assessment already covers it.
        </p>
      )}

      {isOk && state.findings.length > 0 && (
        <>
          <ul className="mt-3 space-y-1.5">
            {state.findings.map((f, idx) => (
              <li
                key={idx}
                className={`rounded-md border px-3 py-2 text-[11px] ${
                  f.likelihood === 'high'
                    ? 'border-even-pink-200 bg-even-pink-50/60'
                    : f.likelihood === 'medium'
                    ? 'border-amber-200 bg-amber-50/60'
                    : 'border-even-ink-200 bg-white'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold text-even-navy">{f.condition}</span>
                  <span className="text-[9px] font-medium uppercase tracking-wider text-even-ink-500">
                    {f.likelihood} likelihood
                  </span>
                </div>
                <p className="mt-0.5 text-even-ink-700">{f.rationale}</p>
                {f.source_encounter_ids.length > 0 && (
                  <p className="mt-1 font-mono text-[9px] text-even-ink-400">
                    Based on{' '}
                    {f.source_encounter_ids.length === 1 ? 'encounter' : 'encounters'}{' '}
                    {f.source_encounter_ids.map((id) => id.slice(0, 8)).join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-even-ink-400">
            Last scan {new Date(state.scanned_at).toLocaleTimeString('en-IN')}
            {state.latency_ms ? ` · ${state.latency_ms}ms` : ''}
          </p>
        </>
      )}
    </section>
  );
}
