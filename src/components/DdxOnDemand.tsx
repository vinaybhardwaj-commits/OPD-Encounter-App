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
  /** v3.10.1 — KB chunk numbers (1-based) that ground this finding. */
  citation_numbers?: number[];
};

type CitationChunk = {
  n: number;
  source: string;
  book: string;
  chapter: string | null;
  section: string | null;
  page: number | null;
  similarity: number;
  text_excerpt: string;
};

type DdxState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; findings: DdxFinding[]; citations: CitationChunk[]; scanned_at: string; latency_ms?: number; kb_latency_ms?: number }
  | { kind: 'failed'; error: string };

export type DdxOnDemandProps = {
  encounterId: string;
  /** Pre-loaded findings from encounters.ddx_findings (server-rendered). */
  initialPayload?:
    | {
        status?: 'ok' | 'failed';
        findings?: DdxFinding[];
        citations?: CitationChunk[];
        scanned_at?: string;
        latency_ms?: number;
        kb_latency_ms?: number;
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
        citations: initialPayload.citations ?? [],
        scanned_at: initialPayload.scanned_at ?? new Date().toISOString(),
        latency_ms: initialPayload.latency_ms,
        kb_latency_ms: initialPayload.kb_latency_ms,
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
        citations?: CitationChunk[];
        scanned_at?: string;
        latency_ms?: number;
        kb_latency_ms?: number;
        error?: string;
      };
      if (j.status === 'failed') {
        setState({ kind: 'failed', error: j.error ?? 'ddx_failed' });
        return;
      }
      setState({
        kind: 'ok',
        findings: j.findings ?? [],
        citations: j.citations ?? [],
        scanned_at: j.scanned_at ?? new Date().toISOString(),
        latency_ms: j.latency_ms,
        kb_latency_ms: j.kb_latency_ms,
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
              <DdxFindingCard
                key={idx}
                finding={f}
                citations={state.citations}
              />
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-even-ink-400">
            Last scan {new Date(state.scanned_at).toLocaleTimeString('en-IN')}
            {state.latency_ms ? ` · qwen ${state.latency_ms}ms` : ''}
            {state.kb_latency_ms ? ` · kb ${state.kb_latency_ms}ms` : ''}
            {state.citations.length > 0 ? ` · ${state.citations.length} ref${state.citations.length === 1 ? '' : 's'}` : ''}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * v3.10.1 — a single DDx card: inline [N] citation chips embedded in the
 * rationale, collapsible Sources chip below that reveals the full
 * book/chapter/page list, click any row → snippet popover.
 */
function DdxFindingCard({
  finding,
  citations,
}: {
  finding: DdxFinding;
  citations: CitationChunk[];
}) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [openSnippet, setOpenSnippet] = useState<number | null>(null);
  const cits = finding.citation_numbers ?? [];
  const myCitations = citations.filter((c) => cits.includes(c.n));

  return (
    <li
      className={`rounded-md border px-3 py-2 text-[11px] ${
        finding.likelihood === 'high'
          ? 'border-even-pink-200 bg-even-pink-50/60'
          : finding.likelihood === 'medium'
          ? 'border-amber-200 bg-amber-50/60'
          : 'border-even-ink-200 bg-white'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-even-navy">{finding.condition}</span>
        <span className="text-[9px] font-medium uppercase tracking-wider text-even-ink-500">
          {finding.likelihood} likelihood
        </span>
      </div>
      <p className="mt-0.5 text-even-ink-700">
        <RationaleWithCitations text={finding.rationale} citations={myCitations} onCitationClick={(n) => setOpenSnippet(n)} />
      </p>
      {finding.source_encounter_ids.length > 0 && (
        <p className="mt-1 font-mono text-[9px] text-even-ink-400">
          Based on{' '}
          {finding.source_encounter_ids.length === 1 ? 'encounter' : 'encounters'}{' '}
          {finding.source_encounter_ids.map((id) => id.slice(0, 8)).join(', ')}
        </p>
      )}
      {myCitations.length > 0 && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setSourcesOpen((o) => !o)}
            className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[9px] font-medium text-violet-700 ring-1 ring-violet-200 hover:bg-violet-100"
          >
            {sourcesOpen ? '▾' : '▸'} Sources · {myCitations.length}
          </button>
          {sourcesOpen && (
            <ul className="mt-1 space-y-0.5 border-l border-violet-200 pl-2">
              {myCitations.map((c) => (
                <li key={c.n}>
                  <button
                    type="button"
                    onClick={() => setOpenSnippet(c.n === openSnippet ? null : c.n)}
                    className="block w-full text-left text-[10px] text-violet-800 hover:underline"
                    title="Click to view the excerpt"
                  >
                    <span className="font-mono mr-1 text-violet-500">[{c.n}]</span>
                    <span className="font-medium">{c.book}</span>
                    {c.chapter && <span className="text-even-ink-600"> — {c.chapter}</span>}
                    {c.section && <span className="text-even-ink-500"> › {c.section}</span>}
                    {c.page && <span className="font-mono text-even-ink-400"> p{c.page}</span>}
                    <span className="ml-1 text-[8px] uppercase text-even-ink-400">{c.source}</span>
                  </button>
                  {openSnippet === c.n && (
                    <div className="mt-1 rounded-md bg-violet-50/60 px-2 py-1.5 text-[10px] italic leading-relaxed text-even-ink-700">
                      {c.text_excerpt}
                      {c.text_excerpt.length >= 600 && '…'}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Parses `[N]` markers in rationale text and renders them as small,
 * clickable chips that match the citation index. Non-marker text is
 * left untouched. Unknown markers (N not in citations) render as plain
 * text so the rationale always reads cleanly.
 */
function RationaleWithCitations({
  text,
  citations,
  onCitationClick,
}: {
  text: string;
  citations: CitationChunk[];
  onCitationClick: (n: number) => void;
}) {
  const validNumbers = new Set(citations.map((c) => c.n));
  const parts: Array<{ kind: 'text' | 'cite'; value: string | number }> = [];
  const regex = /\[(\d+)\]/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push({ kind: 'text', value: text.slice(lastIdx, m.index) });
    const n = parseInt(m[1], 10);
    if (validNumbers.has(n)) parts.push({ kind: 'cite', value: n });
    else parts.push({ kind: 'text', value: m[0] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push({ kind: 'text', value: text.slice(lastIdx) });
  if (parts.length === 0) parts.push({ kind: 'text', value: text });

  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <span key={i}>{p.value as string}</span>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => onCitationClick(p.value as number)}
            className="ml-0.5 inline-flex items-baseline rounded bg-violet-100 px-1 py-0 align-baseline text-[9px] font-mono font-semibold text-violet-700 ring-1 ring-violet-200 hover:bg-violet-200"
            title="Click to view the excerpt"
          >
            [{p.value}]
          </button>
        ),
      )}
    </>
  );
}
