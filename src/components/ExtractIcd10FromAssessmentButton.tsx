'use client';

/**
 * <ExtractIcd10FromAssessmentButton /> — v3.8 explicit "Extract ICD-10
 * codes from the assessment prose" button.
 *
 * Doctor writes prose like "HTN + T2DM, both well-controlled" in the
 * assessment textarea. Clicking this button sends the prose to
 * /api/icd10/interpret with encounter context, renders extracted codes
 * below the button. Each clickable to add as a chip.
 */
import { useState } from 'react';

type Suggestion = { code: string; label: string; rationale: string; confidence: number };

export function ExtractIcd10FromAssessmentButton({
  encounterId,
  assessmentText,
  alreadyAddedCodes,
  onAdd,
}: {
  encounterId: string;
  assessmentText: string;
  alreadyAddedCodes: Set<string>;
  onAdd: (item: { code: string; label: string }) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const extract = async () => {
    if (assessmentText.trim().length < 3) return;
    setLoading(true);
    setSuggestions(null);
    setErr(null);
    console.log('[Extract ICD-10] submitting', { encounter_id: encounterId, len: assessmentText.trim().length });
    try {
      const res = await fetch('/api/icd10/interpret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ free_text: assessmentText.trim(), encounter_id: encounterId }),
        credentials: 'same-origin',
      });
      const text = await res.text();
      let json: { ok?: boolean; suggestions?: Suggestion[]; latency_ms?: number; error?: string };
      try { json = JSON.parse(text); }
      catch { json = { ok: false, error: 'non-json response: ' + text.slice(0, 100) }; }
      console.log('[Extract ICD-10] response', { status: res.status, ok: json.ok, count: json.suggestions?.length, error: json.error });
      if (!res.ok) {
        setErr(`Server returned ${res.status}: ${json.error ?? 'unknown'}`);
      } else if (!json.ok) {
        setErr(`AI error: ${json.error ?? 'unknown'}`);
      } else if (!Array.isArray(json.suggestions)) {
        setErr('Bad response shape — no suggestions array');
      } else {
        setSuggestions(json.suggestions);
        setLatencyMs(json.latency_ms ?? null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Extract ICD-10] fetch failed', msg);
      setErr(`Network error: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      <button
        type="button"
        onClick={extract}
        disabled={loading || assessmentText.trim().length < 3}
        className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
      >
        {loading ? '⟳ Reading assessment…' : '✨ Extract ICD-10 from assessment'}
      </button>

      {suggestions && suggestions.length > 0 && (
        <div className="rounded-md border border-violet-200 bg-violet-50/30 p-2">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-wider text-violet-700">
              Extracted from your assessment
            </span>
            {latencyMs !== null && (
              <span className="text-[10px] text-even-ink-400">
                {suggestions.length} code{suggestions.length === 1 ? '' : 's'} · {(latencyMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => {
              const added = alreadyAddedCodes.has(s.code);
              return (
                <button
                  key={s.code}
                  type="button"
                  onClick={() => !added && onAdd({ code: s.code, label: s.label })}
                  disabled={added}
                  title={`${s.label}${s.rationale ? ' · ' + s.rationale : ''} · ${(s.confidence * 100).toFixed(0)}%`}
                  className={`inline-flex items-baseline gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                    added
                      ? 'cursor-default border-even-ink-200 bg-even-ink-100 text-even-ink-400'
                      : 'border-violet-200 bg-white text-even-navy hover:bg-violet-50'
                  }`}
                >
                  <span>{added ? '✓' : '+'}</span>
                  <span className="font-mono font-semibold">{s.code}</span>
                  <span className="truncate max-w-[14rem] text-even-ink-600">{s.label}</span>
                  <span className="text-[10px] text-violet-700">{(s.confidence * 100).toFixed(0)}%</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {suggestions && suggestions.length === 0 && !loading && (
        <div className="text-[11px] italic text-even-ink-400">
          Couldn&apos;t extract codes from this assessment. Try writing more, or add via the search above.
        </div>
      )}

      {err && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
          {err}
        </div>
      )}
    </div>
  );
}
