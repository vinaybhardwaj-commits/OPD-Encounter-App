'use client';

/**
 * <Icd10SuggestedChips /> — v3.8 passive Qwen ICD-10 chips from
 * encounter context. Auto-fires on mount + when assessment text changes
 * server-side (context_hash recomputes).
 *
 * Renders above the Icd10Typeahead. Each chip clickable to add as
 * an ICD-10 code. Failure-silent.
 */
import { useEffect, useState } from 'react';

type Suggestion = { code: string; label: string; rationale: string; confidence: number };
type Payload =
  | { status: 'ok'; findings: Suggestion[]; generated_at: string; latency_ms: number }
  | { status: 'failed'; error: string; generated_at: string };

export function Icd10SuggestedChips({
  encounterId,
  alreadyAddedCodes,
  onAdd,
}: {
  encounterId: string;
  alreadyAddedCodes: Set<string>;
  onAdd: (item: { code: string; label: string }) => void;
}) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [cached, setCached] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch(`/api/encounters/${encounterId}/icd10-suggest`);
        const json = await res.json();
        if (!cancel && json.ok) {
          setPayload(json.payload);
          setCached(json.cached);
        }
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [encounterId]);

  if (loading) {
    return (
      <p className="text-[11px] italic text-violet-700">
        Reading the encounter context for ICD-10 suggestions…
      </p>
    );
  }

  if (!payload || payload.status === 'failed') return null;
  if (payload.findings.length === 0) return null;

  // v4.0.6 — flat chip wall, no bordered card (matches Section 1 pattern).
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-700">
        <span aria-hidden>✨</span>
        AI suggestions
      </span>
      {cached && <span className="text-[10px] text-even-ink-400">cached</span>}
      {payload.findings.map((f) => {
        const added = alreadyAddedCodes.has(f.code);
        return (
          <button
            key={f.code}
            type="button"
            onClick={() => !added && onAdd({ code: f.code, label: f.label })}
            disabled={added}
            title={`${f.label}${f.rationale ? ' · ' + f.rationale : ''} · ${(f.confidence * 100).toFixed(0)}%`}
            className={`inline-flex items-baseline gap-1.5 rounded-full px-2.5 py-1 text-xs transition ${
              added
                ? 'cursor-default bg-even-ink-50 text-even-ink-400 ring-1 ring-even-ink-200'
                : 'bg-violet-50 text-violet-900 ring-1 ring-violet-300 hover:ring-violet-500'
            }`}
          >
            <span>{added ? '✓' : '+'}</span>
            <span className="font-mono font-semibold">{f.code}</span>
            <span className="truncate max-w-[12rem] text-even-ink-600">{f.label}</span>
            <span className="text-[10px] text-violet-700">{(f.confidence * 100).toFixed(0)}%</span>
          </button>
        );
      })}
    </div>
  );
}
