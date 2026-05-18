'use client';

/**
 * <Icd10Typeahead /> — ICD-10 picker for the Assessment section.
 *
 * UX mirrors <DrugTypeahead>: debounced fetch, ↑ ↓ Enter Esc, mouse
 * hover sets active idx, match highlighting in code + label. On pick:
 * onSelect fires with the full code+label, query clears, focus stays
 * in the input so the doctor can stack a second code in one motion.
 *
 * Simpler than the drug picker — no schedule chips, no LASA, no
 * high-risk badge. Just code (mono) + label.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Icd10Code } from '@/lib/icd10';

type ApiResponse = {
  ok: boolean;
  q: string;
  count: number;
  latency_ms?: number;
  results: Icd10Code[];
};

export type Icd10TypeaheadProps = {
  onSelect: (item: Icd10Code) => void;
  placeholder?: string;
  /** Codes the parent already has — used to dim duplicates in the dropdown. */
  excludeCodes?: string[];
};

export function Icd10Typeahead({
  onSelect,
  placeholder = 'Search ICD-10 — try "hyper", "diabetes", or "J02"',
  excludeCodes = [],
}: Icd10TypeaheadProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Icd10Code[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const excludeSet = new Set(excludeCodes);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/icd10/search?q=${encodeURIComponent(q)}&limit=10`,
          { signal: ctrl.signal },
        );
        const j = (await res.json()) as ApiResponse;
        if (ctrl.signal.aborted) return;
        setResults(j.results ?? []);
        setLatencyMs(j.latency_ms ?? null);
        setActiveIdx(0);
        setOpen(true);
      } catch (e) {
        if ((e as { name?: string }).name !== 'AbortError') {
          setResults([]);
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIdx(0);
  }, []);

  const pick = useCallback(
    (item: Icd10Code) => {
      if (excludeSet.has(item.code)) return;
      onSelect(item);
      setQuery('');
      setResults([]);
      close();
      inputRef.current?.focus();
    },
    [onSelect, close, excludeSet],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      if (results.length > 0) setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      if (results[activeIdx]) {
        e.preventDefault();
        pick(results[activeIdx]);
      }
    } else if (e.key === 'Escape') {
      close();
      inputRef.current?.blur();
    }
  }

  const showPanel = open && (loading || results.length > 0 || query.trim().length >= 1);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listboxId}
        aria-activedescendant={
          results[activeIdx] ? `${listboxId}-opt-${activeIdx}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (results.length > 0) setOpen(true);
        }}
        onBlur={() => setTimeout(close, 120)}
        onKeyDown={onKeyDown}
        className="w-full rounded-lg border border-even-ink-200 bg-white px-3 py-2 text-sm text-even-navy placeholder-even-ink-300 focus:border-even-blue focus:outline-none focus:ring-2 focus:ring-even-blue-100"
      />

      {showPanel && (
        <div
          role="listbox"
          id={listboxId}
          className="absolute left-0 right-0 z-10 mt-2 max-h-[22rem] overflow-y-auto rounded-xl border border-even-ink-200 bg-white shadow-lg"
        >
          {loading && results.length === 0 && (
            <div className="px-4 py-3 text-xs text-even-ink-500">Searching…</div>
          )}
          {!loading && results.length === 0 && query.trim().length >= 1 && (
            <div className="px-4 py-3 text-xs text-even-ink-500">
              No ICD-10 match for{' '}
              <span className="font-mono text-even-navy">{query}</span>
            </div>
          )}
          {results.map((r, i) => {
            const already = excludeSet.has(r.code);
            return (
              <div
                key={r.code}
                role="option"
                id={`${listboxId}-opt-${i}`}
                aria-selected={i === activeIdx}
                onMouseEnter={() => setActiveIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(r);
                }}
                className={`cursor-pointer border-b border-even-ink-100 px-4 py-2 last:border-b-0 ${
                  i === activeIdx ? 'bg-even-blue-50' : 'bg-white'
                } ${already ? 'opacity-50' : ''}`}
              >
                <div className="flex items-baseline gap-3">
                  <span className="shrink-0 font-mono text-xs font-semibold text-even-navy">
                    <Highlighted text={r.code} q={query} />
                  </span>
                  <span className="truncate text-xs text-even-ink-600">
                    <Highlighted text={r.label} q={query} />
                  </span>
                  {already && (
                    <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-even-ink-400">
                      added
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {results.length > 0 && latencyMs != null && (
            <div className="border-t border-even-ink-100 px-4 py-1.5 text-[10px] font-mono text-even-ink-400">
              {results.length} results · {latencyMs} ms
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Highlighted({ text, q }: { text: string; q: string }) {
  const query = q.trim();
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const target = query.toLowerCase();
  const idx = lower.indexOf(target);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="font-semibold text-even-blue-700">
        {text.slice(idx, idx + target.length)}
      </span>
      {text.slice(idx + target.length)}
    </>
  );
}
