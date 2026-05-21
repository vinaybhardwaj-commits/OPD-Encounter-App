'use client';

/**
 * <DiagnosticSearch /> — the shared search primitive.
 *
 * Renders a debounced search input + result list against
 * GET /api/admin/diagnostic-catalog. Stateless w.r.t. cart — calls
 * `onAdd(row)` when the doctor taps `+` on a result. Cart is managed
 * by the parent (the QuickAddStrip in v3.2a, the OrderModal in v3.2b).
 *
 * v3.2a: deterministic search only (pg_trgm + tsvector).
 * v3.5b: parent will also wire a "Suggest with Qwen" button that calls
 *        POST /api/diagnostics/interpret and renders results below.
 */
import { useEffect, useState } from 'react';

export type CatalogRow = {
  service_code: string;
  display_name: string;
  modality: 'lab' | 'imaging' | 'cardiology' | 'procedure';
  sub_department: string;
  patient_instructions: string | null;
  synonyms: string[];
};

const MODALITY_BADGE: Record<CatalogRow['modality'], string> = {
  lab: 'bg-blue-50 text-blue-700 border-blue-200',
  imaging: 'bg-violet-50 text-violet-700 border-violet-200',
  cardiology: 'bg-rose-50 text-rose-700 border-rose-200',
  procedure: 'bg-amber-50 text-amber-700 border-amber-200',
};

export function DiagnosticSearch({
  onAdd,
  cartCodes,
  modality,
  placeholder,
  autoFocus,
}: {
  onAdd: (row: CatalogRow) => void;
  cartCodes: Set<string>;
  modality?: CatalogRow['modality'];
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [took, setTook] = useState<number | null>(null);

  useEffect(() => {
    if (q.trim().length === 0) { setRows([]); setTook(null); return; }
    const id = setTimeout(async () => {
      setLoading(true);
      const params = new URLSearchParams();
      params.set('q', q.trim());
      if (modality) params.set('modality', modality);
      params.set('limit', '10');
      try {
        const res = await fetch(`/api/admin/diagnostic-catalog?${params}`);
        const json = await res.json();
        if (json.ok) {
          setRows(json.rows);
          setTook(json.took_ms);
        }
      } finally { setLoading(false); }
    }, 200);
    return () => clearTimeout(id);
  }, [q, modality]);

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder ?? 'Type tests in any words — e.g. "diabetic FU panel + thyroid + b12"'}
          autoFocus={autoFocus}
          className="flex-1 rounded-md border border-even-ink-200 bg-white px-3 py-2 text-sm focus:border-even-blue focus:outline-none focus:ring-2 focus:ring-even-blue-100"
        />
      </div>

      {q.trim().length > 0 && (
        <div className="mt-2 text-[11px] text-even-ink-400">
          {loading ? 'Searching…' : `${rows.length} instant match${rows.length === 1 ? '' : 'es'}${took !== null ? ` · ${took}ms` : ''}`}
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-2 divide-y divide-even-ink-50 overflow-hidden rounded-md border border-even-ink-100 bg-white">
          {rows.map((r) => {
            const inCart = cartCodes.has(r.service_code);
            return (
              <div
                key={r.service_code}
                className="flex items-start justify-between gap-3 px-3 py-2 hover:bg-even-blue-50/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-medium text-even-navy">{r.display_name}</span>
                    <span className={`shrink-0 rounded-full border px-1.5 py-0 text-[10px] ${MODALITY_BADGE[r.modality]}`}>
                      {r.modality}
                    </span>
                  </div>
                  <div className="text-[11px] text-even-ink-500">{r.sub_department}</div>
                  {r.patient_instructions && (
                    <div className="text-[11px] italic text-even-ink-500">{r.patient_instructions}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => !inCart && onAdd(r)}
                  disabled={inCart}
                  className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium ${
                    inCart
                      ? 'cursor-default bg-even-ink-100 text-even-ink-400'
                      : 'bg-even-blue text-white hover:bg-even-blue-700'
                  }`}
                >
                  {inCart ? '✓ Added' : '+ Add'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
