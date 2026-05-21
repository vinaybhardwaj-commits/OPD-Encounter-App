'use client';

/**
 * <DiagnosticsQuickAddStrip /> — inline diagnostics ordering section
 * for the EncounterEditor (PRD §4.7).
 *
 * Mirrors Prescription's "Add a drug" pattern: collapsed by default,
 * expands into a free-text search strip + cart on tap. Adding from the
 * deterministic search uses the shared <DiagnosticSearch> primitive.
 *
 * v3.2a (this commit): deterministic search only. Cart confirm writes
 *   to the new diagnostic_orders table + flips encounter to
 *   paused_diagnostics atomically.
 * v3.5a (later): passive Qwen context chips above the search input.
 * v3.5b (later): active "Suggest with Qwen" button + free-text NLP.
 *
 * Existing v2 OrderLabModal is NOT touched — it remains accessible from
 * the action bar as the secondary/comprehensive path. v3.2b will swap
 * it out for the new DiagnosticOrderModal.
 */
import { useState } from 'react';
import { DiagnosticSearch, type CatalogRow } from './DiagnosticSearch';

type CartItem = {
  service_code: string;
  display_name: string;
  sub_department: string;
  modality: CatalogRow['modality'];
  source: 'manual' | 'qwen_suggestion_accepted' | 'bundle' | 'context_chip';
};

const MODALITY_BADGE: Record<CatalogRow['modality'], string> = {
  lab: 'bg-blue-50 text-blue-700 border-blue-200',
  imaging: 'bg-violet-50 text-violet-700 border-violet-200',
  cardiology: 'bg-rose-50 text-rose-700 border-rose-200',
  procedure: 'bg-amber-50 text-amber-700 border-amber-200',
};

export function DiagnosticsQuickAddStrip({
  encounterId,
  onConfirmed,
  readOnly,
}: {
  encounterId: string;
  onConfirmed?: (orderIds: string[]) => void;
  readOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmedMessage, setConfirmedMessage] = useState<string | null>(null);

  const cartCodes = new Set(cart.map((c) => c.service_code));

  const add = (row: CatalogRow) => {
    if (cartCodes.has(row.service_code)) return;
    setCart((cur) => [...cur, {
      service_code: row.service_code,
      display_name: row.display_name,
      sub_department: row.sub_department,
      modality: row.modality,
      source: 'manual',
    }]);
  };
  const remove = (code: string) => setCart((cur) => cur.filter((c) => c.service_code !== code));

  const confirm = async () => {
    if (cart.length === 0) return;
    setConfirming(true); setErr(null);
    try {
      const res = await fetch(`/api/encounters/${encounterId}/diagnostics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cart: cart.map((c) => ({ service_code: c.service_code, source: c.source })),
        }),
      });
      const json = await res.json();
      if (!json.ok) { setErr(json.error ?? 'confirm_failed'); return; }
      setConfirmedMessage(`Ordered ${cart.length} test${cart.length === 1 ? '' : 's'}. Encounter paused for diagnostics.`);
      setCart([]);
      if (onConfirmed) onConfirmed(json.order_ids ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setConfirming(false); }
  };

  if (readOnly) return null;

  return (
    <div className="rounded-xl border border-even-ink-100 bg-white">
      <div className="border-b border-even-ink-50 px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-even-navy">
            Diagnostics · Qwen
          </h2>
          <p className="text-[11px] text-even-ink-400">
            Order tests; chips fill from defaults. Tap to override.
          </p>
        </div>
      </div>

      <div className="px-4 py-4 space-y-3">
        {confirmedMessage && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            ✓ {confirmedMessage}
          </div>
        )}

        {!expanded && cart.length === 0 && !confirmedMessage && (
          <>
            <div className="rounded-md border border-dashed border-even-ink-200 bg-even-ink-50/40 px-3 py-3 text-center text-xs text-even-ink-400">
              No tests yet. Add the first one to start.
            </div>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="rounded-md border border-dashed border-even-blue-300 px-3 py-1.5 text-xs font-medium text-even-blue-700 hover:bg-even-blue-50"
            >
              + Add a test
            </button>
          </>
        )}

        {expanded && (
          <div className="rounded-md border border-even-blue-100 bg-even-blue-50/30 p-3">
            <DiagnosticSearch
              onAdd={add}
              cartCodes={cartCodes}
              autoFocus
            />
            <div className="mt-3 flex items-center justify-between text-[11px] text-even-ink-500">
              <span>Type to search the EHRC catalog (2,334 tests).</span>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="text-even-ink-500 hover:text-even-navy"
              >
                Hide search ↑
              </button>
            </div>
          </div>
        )}

        {cart.length > 0 && (
          <div className="rounded-md border border-even-ink-100 bg-white">
            <div className="border-b border-even-ink-50 px-3 py-2 text-[11px] uppercase tracking-wider text-even-ink-500">
              Cart · {cart.length} test{cart.length === 1 ? '' : 's'} pending order
            </div>
            <ul className="divide-y divide-even-ink-50">
              {cart.map((c) => (
                <li key={c.service_code} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium text-even-navy">{c.display_name}</span>
                      <span className={`shrink-0 rounded-full border px-1.5 py-0 text-[10px] ${MODALITY_BADGE[c.modality]}`}>
                        {c.modality}
                      </span>
                      <span className="shrink-0 rounded-full bg-even-ink-100 px-1.5 py-0 text-[10px] text-even-ink-600">
                        {c.source === 'manual' ? 'manual' : c.source.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="text-[11px] text-even-ink-500">{c.sub_department}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(c.service_code)}
                    aria-label={`Remove ${c.display_name}`}
                    className="rounded-md px-2 py-1 text-xs text-even-ink-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    × Remove
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-even-ink-50 px-3 py-2">
              <div className="text-[11px] text-even-ink-500">
                Confirm flips encounter to <span className="font-mono">paused_diagnostics</span>.
              </div>
              <div className="flex gap-2">
                {!expanded && (
                  <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="rounded-md border border-even-ink-200 bg-white px-3 py-1 text-xs hover:bg-even-ink-50"
                  >
                    + Add more
                  </button>
                )}
                <button
                  type="button"
                  onClick={confirm}
                  disabled={confirming || cart.length === 0}
                  className="rounded-md bg-even-blue px-3 py-1 text-xs font-medium text-white hover:bg-even-blue-700 disabled:opacity-50"
                >
                  {confirming ? 'Ordering…' : `Confirm ${cart.length} order${cart.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
            {err && (
              <div className="border-t border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {err}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
