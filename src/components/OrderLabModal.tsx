'use client';

/**
 * <OrderLabModal /> — v2.1.1 doctor lab-ordering surface.
 *
 * Separate from <SendToDiagnosticsModal> on purpose:
 *   - SendToDiagnosticsModal is for IMAGING (CXR/ECG/USG/Echo) — sets a
 *     single pending_diagnostic_test string and pauses the encounter.
 *     v1 design, unchanged in v2.1.
 *   - OrderLabModal is for LAB PANELS (CBC, LFT, KFT, HbA1c, lipid, …)
 *     — N rows in lab_orders, multi-test, supports CCE pre-stage
 *     confirmation, fires Qwen-VL extraction downstream.
 *
 * UX choreography:
 *   1. Open the modal from EncounterEditor's action bar.
 *   2. Modal fetches GET /api/encounters/[id]/labs on open.
 *      - Pre-staged rows from CCE show with a 🧪 "Pre-staged by …" chip.
 *      - Pending/in_progress/resulted rows are listed read-only.
 *   3. Doctor types a test name into the input → Enter or +Add appends
 *      a chip. Free-text, no autocomplete (Qwen-VL handles normalisation
 *      after results come back).
 *   4. "Send to lab" POSTs { tests } to /api/encounters/[id]/labs.
 *      The endpoint atomically confirms any pre_staged rows AND inserts
 *      the new ones AND flips status → paused_diagnostics.
 *   5. On success, router.push('/dashboard') so the doctor's queue
 *      reflects the paused state.
 *
 * Closed via Cancel button / Escape / backdrop click.
 *
 * Error surface is inline — no toasts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type ExistingOrder = {
  id: string;
  status: string;
  raw_text: string;
  pre_staged_by_cce_name: string | null;
  pre_staged_at: string | null;
  ordering_doctor_name: string | null;
  ordered_at: string;
  resulted_at: string | null;
};

type LoadedOrders = {
  ok: boolean;
  orders?: ExistingOrder[];
  error?: string;
};

const QUICK_CHIPS = [
  'CBC',
  'LFT',
  'KFT (Urea, Creatinine, Electrolytes)',
  'HbA1c',
  'Fasting lipid panel',
  'TSH',
  'Vitamin D (25-OH)',
  'Vitamin B12',
  'Urine R/M',
  'RBS',
];

export type OrderLabModalProps = {
  encounterId: string;
  patientName: string;
  open: boolean;
  onClose: () => void;
};

export function OrderLabModal({
  encounterId,
  patientName,
  open,
  onClose,
}: OrderLabModalProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [draftInput, setDraftInput] = useState('');
  const [drafts, setDrafts] = useState<string[]>([]);
  const [existing, setExisting] = useState<ExistingOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state when (re)opened.
  useEffect(() => {
    if (!open) {
      setDraftInput('');
      setDrafts([]);
      setError(null);
      setExisting([]);
      return;
    }
    let aborted = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/encounters/${encounterId}/labs`, {
          cache: 'no-store',
        });
        const json = (await res.json()) as LoadedOrders;
        if (!aborted && json.ok && json.orders) {
          setExisting(json.orders);
        } else if (!aborted) {
          setError(json.error ?? 'load_failed');
        }
      } catch (e) {
        if (!aborted) {
          setError(e instanceof Error ? e.message : 'network_error');
        }
      } finally {
        if (!aborted) setLoading(false);
      }
    })();
    setTimeout(() => inputRef.current?.focus(), 80);
    return () => {
      aborted = true;
    };
  }, [open, encounterId]);

  // Esc to close
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

  const preStagedCount = useMemo(
    () => existing.filter((o) => o.status === 'pre_staged').length,
    [existing],
  );
  const totalToSend = drafts.length + preStagedCount;

  const onSend = useCallback(async () => {
    if (totalToSend === 0) {
      setError('Add at least one lab, or confirm a pre-staged one.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/encounters/${encounterId}/labs`, {
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
        setError(json.detail ?? json.error ?? 'send_failed');
        setBusy(false);
        return;
      }
      onClose();
      router.push('/dashboard');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network_error');
      setBusy(false);
    }
  }, [drafts, encounterId, onClose, router, totalToSend]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-even-navy/40 px-4 pb-6 pt-12 sm:items-center sm:py-12"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="orderlab-title"
        className="relative w-full max-w-xl rounded-2xl bg-white shadow-2xl ring-1 ring-even-ink-100"
      >
        <header className="border-b border-even-ink-100 px-6 py-4">
          <h2
            id="orderlab-title"
            className="text-base font-semibold tracking-tight text-even-navy"
          >
            Order labs for {patientName}
          </h2>
          <p className="mt-0.5 text-xs text-even-ink-500">
            Free-text test names. Qwen normalises them after results come back.
          </p>
        </header>

        <div className="space-y-4 px-6 py-4">
          {/* Pre-staged section */}
          {loading ? (
            <p className="text-xs text-even-ink-400">Loading existing orders…</p>
          ) : preStagedCount > 0 ? (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-even-blue-700">
                Pre-staged by CCE — confirm to send
              </h3>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {existing
                  .filter((o) => o.status === 'pre_staged')
                  .map((o) => (
                    <li
                      key={o.id}
                      className="inline-flex items-center gap-1 rounded-full border border-even-blue-300 bg-even-blue-50 px-2.5 py-1 text-[11px] text-even-blue-900"
                    >
                      <span>🧪</span>
                      <span className="font-medium">{o.raw_text}</span>
                      {o.pre_staged_by_cce_name && (
                        <span className="text-[10px] text-even-blue-700">
                          · {firstName(o.pre_staged_by_cce_name)}
                        </span>
                      )}
                    </li>
                  ))}
              </ul>
              <p className="mt-1 text-[10px] text-even-ink-400">
                Pressing &quot;Send to lab&quot; below confirms these {preStagedCount}{' '}
                pre-staged labs in the same write.
              </p>
            </section>
          ) : null}

          {/* Quick chips */}
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
                    className="rounded-full border border-even-ink-200 bg-white px-2.5 py-1 text-[11px] text-even-ink-700 transition hover:border-even-navy-300 hover:bg-even-navy-50 disabled:opacity-50"
                  >
                    + {c}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {/* Free-text input */}
          <section>
            <label
              htmlFor="orderlab-input"
              className="text-[11px] font-semibold uppercase tracking-wider text-even-ink-500"
            >
              Or type any test name
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                ref={inputRef}
                id="orderlab-input"
                value={draftInput}
                onChange={(e) => setDraftInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addDraft(draftInput);
                  }
                }}
                placeholder="e.g. Anti-CCP, Iron studies, Spot urine ACR"
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

          {/* Drafts list */}
          {drafts.length > 0 && (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-even-ink-500">
                New orders ({drafts.length})
              </h3>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {drafts.map((d) => (
                  <li
                    key={d}
                    className="inline-flex items-center gap-2 rounded-full border border-even-navy-200 bg-even-navy-50 px-2.5 py-1 text-[11px] text-even-navy"
                  >
                    <span className="font-medium">{d}</span>
                    <button
                      type="button"
                      onClick={() => removeDraft(d)}
                      className="text-even-navy/60 hover:text-even-pink-700"
                      aria-label={`Remove ${d}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Already-pending read-only summary */}
          {existing.filter((o) => o.status !== 'pre_staged').length > 0 && (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-even-ink-500">
                Already in flight
              </h3>
              <ul className="mt-1.5 space-y-1 text-[11px] text-even-ink-600">
                {existing
                  .filter((o) => o.status !== 'pre_staged')
                  .map((o) => (
                    <li key={o.id} className="flex items-baseline justify-between gap-2">
                      <span className="truncate">{o.raw_text}</span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-even-ink-400">
                        {o.status.replace(/_/g, ' ')}
                      </span>
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
            disabled={busy || totalToSend === 0}
            className="rounded-lg bg-even-navy px-4 py-2 text-xs font-semibold text-white transition hover:bg-even-navy-700 disabled:opacity-50"
          >
            {busy
              ? 'Sending…'
              : `Send to lab${
                  totalToSend > 0 ? ` (${totalToSend})` : ''
                } & pause`}
          </button>
        </footer>
      </div>
    </div>
  );
}

function firstName(full: string): string {
  return (full.split(/\s+/)[0] || full).replace(/^Dr\.?\s+|^Nurse\s+/i, '');
}
