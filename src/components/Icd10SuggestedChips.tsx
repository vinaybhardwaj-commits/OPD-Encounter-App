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
      <div className="rounded-md border border-violet-100 bg-violet-50/30 px-3 py-2 text-[11px] italic text-violet-700">
        Qwen is reading the encounter context for ICD-10 suggestions…
      </div>
    );
  }

  if (!payload || payload.status === 'failed') return null;
  if (payload.findings.length === 0) return null;

  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/30 p-2">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wider text-violet-700">
          ICD-10 · Qwen suggests from context
        </span>
        {cached && <span className="text-[10px] text-even-ink-400">cached</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {payload.findings.map((f) => {
          const added = alreadyAddedCodes.has(f.code);
          return (
            <button
              key={f.code}
              type="button"
              onClick={() => !added && onAdd({ code: f.code, label: f.label })}
              disabled={added}
              title={`${f.label}${f.rationale ? ' · ' + f.rationale : ''} · ${(f.confidence * 100).toFixed(0)}%`}
              className={`inline-flex items-baseline gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                added
                  ? 'cursor-default border-even-ink-200 bg-even-ink-100 text-even-ink-400'
                  : 'border-violet-200 bg-white text-even-navy hover:bg-violet-50'
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
    </div>
  );
}
