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
  /** When set, exposes a "Suggest with Qwen ↩" button + renders Qwen suggestions below the dropdown. v3.8. */
  encounterId?: string;
};

type QwenSuggestion = { code: string; label: string; rationale: string; confidence: number };

export function Icd10Typeahead({
  onSelect,
  placeholder = 'Search ICD-10 — try "T2DM", "HTN uncontrolled", or "J02"',
  excludeCodes = [],
  encounterId,
}: Icd10TypeaheadProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Icd10Code[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  // v3.8 — Qwen NLP state (only used when encounterId is set)
  const [qwenLoading, setQwenLoading] = useState(false);
  const [qwenSuggestions, setQwenSuggestions] = useState<QwenSuggestion[] | null>(null);
  const [qwenLatencyMs, setQwenLatencyMs] = useState<number | null>(null);

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
      setQwenSuggestions(null);
      close();
      inputRef.current?.focus();
    },
    [onSelect, close, excludeSet],
  );

  const submitQwen = useCallback(async () => {
    if (!encounterId || query.trim().length < 2 || qwenLoading) return;
    setQwenLoading(true);
    setQwenSuggestions(null);
    try {
      const res = await fetch('/api/icd10/interpret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ free_text: query.trim(), encounter_id: encounterId }),
      });
      const json = await res.json();
      if (json.ok && Array.isArray(json.suggestions)) {
        setQwenSuggestions(json.suggestions);
        setQwenLatencyMs(json.latency_ms ?? null);
      }
    } finally {
      setQwenLoading(false);
    }
  }, [encounterId, query, qwenLoading]);

  const pickQwen = useCallback((s: QwenSuggestion) => {
    onSelect({ code: s.code, label: s.label });
    setQuery('');
    setResults([]);
    setQwenSuggestions(null);
    close();
    inputRef.current?.focus();
  }, [onSelect, close]);

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
      <div className="flex gap-2">
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
          className="flex-1 rounded-lg border border-even-ink-200 bg-white px-3 py-2 text-sm text-even-navy placeholder-even-ink-300 focus:border-even-blue focus:outline-none focus:ring-2 focus:ring-even-blue-100"
        />
        {encounterId && (
          <button
            type="button"
            onClick={submitQwen}
            disabled={qwenLoading || query.trim().length < 2}
            title="Ask Qwen to interpret this as an ICD-10 code (handles shorthand like 'T2DM' or 'HTN uncontrolled')"
            className="shrink-0 rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {qwenLoading ? '⟳ Qwen…' : 'Suggest with Qwen ↩'}
          </button>
        )}
      </div>

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

      {/* v3.8 — Qwen NLP suggestions block (only when encounterId set) */}
      {encounterId && qwenLoading && (
        <div className="mt-2 rounded-md border border-violet-200 bg-violet-50/40 px-3 py-2 text-[11px] italic text-violet-700">
          Qwen is interpreting &quot;{query}&quot; as ICD-10…
        </div>
      )}

      {encounterId && qwenSuggestions && qwenSuggestions.length > 0 && (
        <div className="mt-2 rounded-md border border-violet-200 bg-violet-50/30 p-2">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-wider text-violet-700">Suggested by Qwen</span>
            <span className="text-[10px] text-even-ink-400">
              {qwenSuggestions.length} code{qwenSuggestions.length === 1 ? '' : 's'}
              {qwenLatencyMs !== null && ` · ${(qwenLatencyMs / 1000).toFixed(1)}s`}
            </span>
          </div>
          <div className="divide-y divide-violet-100 overflow-hidden rounded-md bg-white">
            {qwenSuggestions.map((s) => {
              const already = excludeSet.has(s.code);
              return (
                <div key={s.code} className="flex items-start justify-between gap-3 px-3 py-2 hover:bg-violet-50/30">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="shrink-0 font-mono text-xs font-semibold text-even-navy">{s.code}</span>
                      <span className="truncate text-xs text-even-ink-600">{s.label}</span>
                      <span className="shrink-0 text-[10px] text-violet-700">{(s.confidence * 100).toFixed(0)}%</span>
                    </div>
                    {s.rationale && (
                      <div className="text-[10px] italic text-violet-600">{s.rationale}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => !already && pickQwen(s)}
                    disabled={already}
                    className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium ${
                      already
                        ? 'cursor-default bg-even-ink-100 text-even-ink-400'
                        : 'bg-violet-600 text-white hover:bg-violet-700'
                    }`}
                  >
                    {already ? '✓ Added' : '+ Add'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {encounterId && !qwenLoading && qwenSuggestions && qwenSuggestions.length === 0 && (
        <div className="mt-2 text-[11px] italic text-even-ink-400">
          Qwen couldn&apos;t map &quot;{query}&quot; to an ICD-10 code.
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
