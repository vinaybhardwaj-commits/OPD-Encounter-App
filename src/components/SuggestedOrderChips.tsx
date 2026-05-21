'use client';

/**
 * <SuggestedOrderChips /> — v3.5a passive AI context chips.
 *
 * Auto-fetches Qwen-derived suggestions from the encounter context on
 * mount (or when context_hash changes server-side). Renders chips above
 * the strip's search input. Click chip → onAdd(row). "Accept all ≥ 0.75"
 * bulk-adds.
 *
 * Failure-silent per PRD: no chips, no toast, just hides.
 */
import { useEffect, useState } from 'react';
import type { CatalogRow } from './DiagnosticSearch';

type Suggestion = {
  service_code: string;
  display_name: string;
  sub_department: string;
  modality: CatalogRow['modality'];
  rationale: string;
  confidence: number;
};

type Payload =
  | { status: 'ok'; findings: Suggestion[]; generated_at: string; latency_ms: number }
  | { status: 'failed'; error: string; generated_at: string };

const MODALITY_BADGE: Record<CatalogRow['modality'], string> = {
  lab: 'bg-blue-50 text-blue-700 border-blue-200',
  imaging: 'bg-violet-50 text-violet-700 border-violet-200',
  cardiology: 'bg-rose-50 text-rose-700 border-rose-200',
  procedure: 'bg-amber-50 text-amber-700 border-amber-200',
};

export function SuggestedOrderChips({
  encounterId,
  onAdd,
  alreadyInCart,
}: {
  encounterId: string;
  onAdd: (row: { service_code: string; display_name: string; sub_department: string; modality: CatalogRow['modality'] }) => void;
  alreadyInCart: Set<string>;
}) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [cached, setCached] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch(`/api/encounters/${encounterId}/suggest-orders`);
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
      <div className="rounded-md border border-even-blue-100 bg-even-blue-50/30 px-3 py-2 text-[11px] italic text-even-blue-700">
        Qwen is suggesting orders from this encounter&apos;s context…
      </div>
    );
  }

  if (!payload || payload.status === 'failed') {
    return null; // Silent failure per PRD §6.A
  }

  if (payload.findings.length === 0) return null;

  const eligibleForAcceptAll = payload.findings.filter(
    (f) => f.confidence >= 0.75 && !alreadyInCart.has(f.service_code),
  );

  return (
    <div className="rounded-md border border-even-blue-100 bg-even-blue-50/30 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wider text-even-blue-700">
            Qwen suggests
          </span>
          {cached && <span className="text-[10px] text-even-ink-400">cached</span>}
        </div>
        {eligibleForAcceptAll.length > 0 && (
          <button
            type="button"
            onClick={() => eligibleForAcceptAll.forEach((f) => onAdd(f))}
            className="rounded-md bg-even-blue px-2 py-0.5 text-[11px] font-medium text-white hover:bg-even-blue-700"
          >
            Accept all ≥ 0.75 ({eligibleForAcceptAll.length})
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {payload.findings.map((f) => {
          const inCart = alreadyInCart.has(f.service_code);
          return (
            <button
              key={f.service_code}
              type="button"
              onClick={() => !inCart && onAdd(f)}
              disabled={inCart}
              title={`${f.rationale} · confidence ${(f.confidence * 100).toFixed(0)}%`}
              className={`inline-flex items-baseline gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                inCart
                  ? 'cursor-default border-even-ink-200 bg-even-ink-100 text-even-ink-400'
                  : 'border-even-blue-200 bg-white text-even-navy hover:bg-even-blue-50'
              } ${MODALITY_BADGE[f.modality]}`}
            >
              <span>{inCart ? '✓' : '+'}</span>
              <span className="font-medium">{f.display_name}</span>
              <span className="text-[10px] opacity-70">{(f.confidence * 100).toFixed(0)}%</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
