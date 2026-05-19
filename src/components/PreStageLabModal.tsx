'use client';

/**
 * <PreStageLabModal /> — CCE pre-stage labs from /reception (v2.1.1).
 *
 * Per-encounter modal: CCE picks an existing encounter row, opens this
 * modal, types or chip-picks 1+ routine labs (CBC, urine R/E, RBS, …)
 * → POST /api/encounters/[id]/labs/prestage creates rows with
 * status='pre_staged' and ordering_doctor_id=NULL.
 *
 * The encounter status is NOT touched. When the doctor opens the
 * encounter, <OrderLabModal> shows the pre-staged rows with a "🧪
 * Pre-staged by <CCE>" chip and one click promotes them to pending
 * (atomically with paused_diagnostics flip).
 *
 * Constraints surfaced to the user:
 *   - Only encounters in registered | at_triage | waiting_for_doctor
 *     are pre-stageable. Server returns 409 with detail if not.
 *   - This modal does NOT show already-pre-staged labs because the
 *     room queue card itself will (v2.1.1+ TODO) show a 🧪 marker per
 *     encounter that has pending pre_stages.
 *
 * UX choreography:
 *   1. CCE clicks "🧪 Pre-stage labs" on an encounter card.
 *   2. Modal opens, focuses the input.
 *   3. Quick-chip click OR free-text + Enter appends a draft chip.
 *   4. "Pre-stage" CTA POSTs and closes.
 *   5. router.refresh() so the room card re-renders the marker.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const QUICK_CHIPS = [
  'CBC',
  'Urine R/M',
  'RBS',
  'FBS + PPBS',
  'HbA1c',
  'Fasting lipid panel',
  'KFT',
  'LFT',
  'TSH',
  'Vitamin D (25-OH)',
];

export type PreStageLabModalProps = {
  encounterId: string;
  patientName: string;
  open: boolean;
  onClose: () => void;
};

export function PreStageLabModal({
  encounterId,
  patientName,
  open,
  onClose,
}: PreStageLabModalProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draftInput, setDraftInput] = useState('');
  const [drafts, setDrafts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setDraftInput('');
      setDrafts([]);
      setError(null);
      return;
    }
    setTimeout(() => inputRef.current?.focus(), 80);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const addDraft = useCallback((t: string) => {
    const trimmed = t.trim();
    if (!trimmed) return;
    setDrafts((prev) =>
      prev.some((d) => d.toLowerCase() === trimmed.toLowerCase())
        ? prev
        : [...prev, trimmed],
    );
    setDraftInput('');
    inputRef.current?.focus();
  }, []);

  const removeDraft = useCallback((t: string) => {
    setDrafts((prev) => prev.filter((d) => d !== t));
  }, []);

  const onSend = useCallback(async () => {
    if (drafts.length === 0) {
      setError('Add at least one lab.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/encounters/${encounterId}/labs/prestage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tests: drafts }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        detail?: string;
      };
      if (!json.ok) {
        setError(json.detail ?? json.error ?? 'prestage_failed');
        setBusy(false);
        return;
      }
      onClose();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network_error');
      setBusy(false);
    }
  }, [drafts, encounterId, onClose, router]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-even-navy/40 px-4 pb-6 pt-12 sm:items-center sm:py-12"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prestage-title"
        className="w-full max-w-lg rounded-2xl bg-white shadow-2xl ring-1 ring-even-ink-100"
      >
        <header className="border-b border-even-ink-100 px-6 py-4">
          <h2
            id="prestage-title"
            className="text-base font-semibold tracking-tight text-even-navy"
          >
            Pre-stage labs · {patientName}
          </h2>
          <p className="mt-0.5 text-xs text-even-ink-500">
            Suggests routine labs to the doctor. Doctor must confirm before they
            go to the lab.
          </p>
        </header>

        <div className="space-y-4 px-6 py-4">
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-even-ink-500">
              Quick add
            </h3>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {QUICK_CHIPS.map((c) => (
                <li key={c}>
                  <button
                    type="button"
                    onClick={() => addDraft(c)}
                    disabled={busy}
                    className="rounded-full border border-even-ink-200 bg-white px-2.5 py-1 text-[11px] text-even-ink-700 transition hover:border-even-blue-300 hover:bg-even-blue-50 disabled:opacity-50"
                  >
                    + {c}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <label
              htmlFor="prestage-input"
              className="text-[11px] font-semibold uppercase tracking-wider text-even-ink-500"
            >
              Or type any test
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                ref={inputRef}
                id="prestage-input"
                value={draftInput}
                onChange={(e) => setDraftInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addDraft(draftInput);
                  }
                }}
                placeholder="e.g. ESR, CRP, Ferritin"
                className="flex-1 rounded-lg border border-even-ink-200 px-3 py-1.5 text-sm placeholder:text-even-ink-300 focus:border-even-navy focus:outline-none focus:ring-1 focus:ring-even-navy"
                disabled={busy}
              />
              <button
                type="button"
                onClick={() => addDraft(draftInput)}
                disabled={busy || !draftInput.trim()}
                className="rounded-lg bg-even-navy px-3 py-1.5 text-xs font-medium text-white transition hover:bg-even-navy-700 disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </section>

          {drafts.length > 0 && (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-even-ink-500">
                Pre-staging ({drafts.length})
              </h3>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {drafts.map((d) => (
                  <li
                    key={d}
                    className="inline-flex items-center gap-2 rounded-full border border-even-blue-200 bg-even-blue-50 px-2.5 py-1 text-[11px] text-even-blue-900"
                  >
                    <span>🧪</span>
                    <span className="font-medium">{d}</span>
                    <button
                      type="button"
                      onClick={() => removeDraft(d)}
                      className="text-even-blue-900/60 hover:text-even-pink-700"
                      aria-label={`Remove ${d}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {error && (
            <p className="rounded-md bg-even-pink-50 px-3 py-2 text-[11px] text-even-pink-800">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-even-ink-100 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-xs font-medium text-even-ink-500 hover:text-even-navy"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={busy || drafts.length === 0}
            className="rounded-lg bg-even-blue px-4 py-2 text-xs font-semibold text-white transition hover:bg-even-blue-700 disabled:opacity-50"
          >
            {busy
              ? 'Pre-staging…'
              : `Pre-stage ${drafts.length || ''} for doctor`}
          </button>
        </footer>
      </div>
    </div>
  );
}
