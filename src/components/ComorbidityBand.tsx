'use client';

/**
 * <ComorbidityBand /> — always-visible chip band at the top of the
 * encounter editor (between patient header and Lab orders section).
 *
 * v3.9.1. Per the v3.9 PRD §4.1, this is the dominant comorbidity
 * surface — visible without a click, sets context for everything
 * below. Layout per §4.2: tier badge (left) + chip row (centre) +
 * actions (right) + trigger reasons line.
 *
 * Clicking '+ Add' or 'Edit all →' opens <ComorbidityEditModal>.
 */
import { useCallback, useEffect, useState } from 'react';
import { TierBadge } from './TierBadge';
import { ComorbidityEditModal } from './ComorbidityEditModal';
import type { TierBreakdown } from '@/lib/comorbidity-tier';

type ApiComorbidity = {
  id: string;
  code: string;
  label: string;
  onset_date: string | null;
  is_resolved: boolean;
  tier: 'core' | 'extended' | null;
  triggers_extended_capture: boolean;
};

export function ComorbidityBand({
  patientId,
  patientName,
  patientAge,
  patientSex,
  readOnly,
}: {
  patientId: string;
  patientName: string;
  patientAge: number;
  patientSex: string;
  readOnly?: boolean;
}) {
  const [comorbidities, setComorbidities] = useState<ApiComorbidity[]>([]);
  const [tier, setTier] = useState<TierBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/patients/${patientId}/comorbidities`);
      const json = await res.json();
      if (json.ok) {
        setComorbidities(json.comorbidities);
        setTier(json.tier);
      }
    } finally { setLoading(false); }
  }, [patientId]);

  useEffect(() => { reload(); }, [reload]);

  const active = comorbidities.filter((c) => !c.is_resolved);
  const empty = active.length === 0;

  return (
    <>
      <section className="rounded-xl border border-even-ink-100 bg-white p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-even-navy">
            Comorbidities &amp; Panel Tier
          </h2>
          <span className="text-[10px] uppercase tracking-wider text-even-ink-400">v3.9</span>
        </div>

        {loading ? (
          <div className="text-xs italic text-even-ink-500">Loading…</div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              {tier && <TierBadge breakdown={tier} size="md" />}
              {empty ? (
                <span className="text-xs italic text-even-ink-500">No comorbidities recorded.</span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {active.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => !readOnly && setModalOpen(true)}
                      className="inline-flex items-baseline gap-1 rounded-full bg-even-blue-50 px-2 py-0.5 text-[11px] text-even-blue-800 ring-1 ring-even-blue-200 hover:bg-even-blue-100"
                      title={`${c.code} — ${c.label}${c.onset_date ? ' · ' + c.onset_date.slice(0, 4) : ''}`}
                    >
                      <span className="font-mono font-semibold">{c.code}</span>
                      <span className="truncate max-w-[12rem]">{c.label}</span>
                      {c.onset_date && <span className="text-even-blue-600">· {c.onset_date.slice(0, 4)}</span>}
                      {c.triggers_extended_capture && <span className="text-amber-600" title="Gateways extended catalog">⚡</span>}
                    </button>
                  ))}
                </div>
              )}
              {!readOnly && (
                <div className="ml-auto flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setModalOpen(true)}
                    className="rounded-md border border-dashed border-even-blue-300 px-2.5 py-1 text-[11px] font-medium text-even-blue-700 hover:bg-even-blue-50"
                  >
                    + Add comorbidity
                  </button>
                  {!empty && (
                    <button
                      type="button"
                      onClick={() => setModalOpen(true)}
                      className="rounded-md border border-even-ink-200 bg-white px-2.5 py-1 text-[11px] font-medium text-even-ink-700 hover:bg-even-ink-50"
                    >
                      Edit all →
                    </button>
                  )}
                </div>
              )}
            </div>

            {tier && tier.trigger_reasons.length > 0 && (
              <div className="mt-2 text-[10px] text-even-ink-500">
                Trigger reasons: {tier.trigger_reasons.join(' · ')}
              </div>
            )}
          </>
        )}
      </section>

      {modalOpen && (
        <ComorbidityEditModal
          patientId={patientId}
          patientName={patientName}
          patientAge={patientAge}
          patientSex={patientSex}
          onClose={() => setModalOpen(false)}
          onSaved={async () => { setModalOpen(false); await reload(); }}
        />
      )}
    </>
  );
}
