'use client';

/**
 * <PrescriptionCompose /> — the multi-drug compose surface mounted inside
 * the encounter screen. Replaces the M3 placeholder card.
 *
 * Behaviour:
 *   - "Add drug" button reveals an inline DrugTypeahead. Picking creates
 *     a new <DrugRow> with smart defaults pre-applied (M4.1). Typeahead
 *     auto-clears so a second pick is one tap away.
 *   - Each row edit (chip override, instructions text) triggers a
 *     debounced PUT /api/encounters/[id]/prescription that upserts the
 *     full lines[] array.
 *   - Save state indicator mirrors the encounter editor's pattern.
 *   - Read-only when the encounter is completed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { DrugTypeahead } from './DrugTypeahead';
import { DrugRow, lineFromDrug, type PrescriptionLine } from './DrugRow';
import { findSmartDefaults } from '@/lib/drug-defaults';
import type { DrugSearchResult } from '@/lib/types';

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export type PrescriptionComposeProps = {
  encounterId: string;
  initialLines: PrescriptionLine[];
  readOnly?: boolean;
};

export function PrescriptionCompose({
  encounterId,
  initialLines,
  readOnly,
}: PrescriptionComposeProps) {
  const [lines, setLines] = useState<PrescriptionLine[]>(initialLines);
  const [adderOpen, setAdderOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipFirstRef = useRef(true);

  // Debounced PUT
  useEffect(() => {
    if (readOnly) return;
    if (skipFirstRef.current) {
      skipFirstRef.current = false;
      return;
    }
    setSaveState('dirty');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSaveState('saving');
      try {
        const res = await fetch(`/api/encounters/${encounterId}/prescription`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lines }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    }, 800);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [lines, encounterId, readOnly]);

  const addPick = useCallback((drug: DrugSearchResult) => {
    setLines((cur) => {
      // Don't double-add the same item_code
      if (cur.some((l) => l.item_code === drug.item_code)) return cur;
      const defaults = findSmartDefaults(drug.generic_name);
      return [...cur, lineFromDrug(drug, defaults)];
    });
  }, []);

  const updateAt = useCallback((idx: number, next: PrescriptionLine) => {
    setLines((cur) => cur.map((l, i) => (i === idx ? next : l)));
  }, []);

  const removeAt = useCallback((idx: number) => {
    setLines((cur) => cur.filter((_, i) => i !== idx));
  }, []);

  const saveLabel =
    saveState === 'dirty' || saveState === 'saving'
      ? 'saving…'
      : saveState === 'error'
      ? 'save failed'
      : saveState === 'saved'
      ? 'saved'
      : '';
  const saveTone =
    saveState === 'error' ? 'text-even-pink-700' : 'text-even-ink-400';

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-even-ink-500">
          {lines.length === 0
            ? 'No drugs yet. Add the first one to start.'
            : `${lines.length} ${lines.length === 1 ? 'drug' : 'drugs'} on the prescription.`}
        </p>
        {saveLabel && (
          <span className={`text-[11px] tabular-nums ${saveTone}`}>
            · {saveLabel}
          </span>
        )}
      </div>

      {!readOnly && (
        <div className="mb-4">
          {adderOpen ? (
            <div>
              <DrugTypeahead
                autoFocus
                clearOnSelect
                onSelect={(d) => {
                  addPick(d);
                  // Keep the picker open for the next drug
                }}
              />
              <button
                type="button"
                onClick={() => setAdderOpen(false)}
                className="mt-2 text-[11px] uppercase tracking-wider text-even-ink-400 hover:text-even-navy"
              >
                Done adding
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdderOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-dashed border-even-blue-300 bg-even-blue-50 px-4 py-2 text-sm font-semibold text-even-blue-700 transition hover:border-even-blue-400 hover:bg-even-blue-100"
            >
              <span aria-hidden>+</span>
              {lines.length === 0 ? 'Add a drug' : 'Add another drug'}
            </button>
          )}
        </div>
      )}

      {lines.length === 0 ? (
        <div className="rounded-xl border border-dashed border-even-ink-200 bg-white p-6 text-center text-xs text-even-ink-400">
          Drugs will appear here as you add them. Each row picks up smart
          defaults so the common case is one tap.
        </div>
      ) : (
        <div className="space-y-3">
          {lines.map((line, idx) => (
            <DrugRow
              key={`${line.item_code}-${idx}`}
              line={line}
              onChange={(next) => updateAt(idx, next)}
              onRemove={() => removeAt(idx)}
              readOnly={readOnly}
            />
          ))}
        </div>
      )}
    </div>
  );
}
