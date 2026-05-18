/**
 * <HistoryPanel> — in-encounter collapsible left panel (PH.3).
 *
 * Default: 40px rail with a chevron icon glued to the left edge of the
 * viewport. Tap → slides out to 360px with a faint backdrop. Tap the
 * backdrop or the chevron to collapse back. State persisted in
 * localStorage under `ph3.panel_open` so the doctor's preference
 * survives between encounters within a session.
 *
 * Contents (when expanded, per PRD §5.2):
 *   1. Header: patient name + "View full history →" link to /patients/[id]
 *   2. Summary line (first 2 lines of summary_text)
 *   3. Problem list — compact, top 4
 *   4. Allergy strip — only renders when non-empty
 *   5. Last 3-5 encounter cards (date + CC chips + primary diagnosis)
 *
 * Recompute / skeleton / failed states land in PH.3.2.
 */
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

// -----------------------------------------------------------------------------
// Types (subset of patient-summary.ts to avoid a server-only import)
// -----------------------------------------------------------------------------

export type HPProblem = {
  label?: string;
  status?: string;
  current_meds?: string[];
  since?: string | null;
};

export type HPAllergy = {
  allergen: string;
  source: string;
  fromOwner?: boolean;
};

export type HPEncounterCard = {
  id: string;
  encounter_date: string;
  encounter_number: string;
  chief_complaint_chips: string[] | null;
  primary_code: string | null;
  disposition: string | null;
};

export type HPSummary = {
  status: string;
  summary_text?: string | null;
  problems: HPProblem[];
  allergies: HPAllergy[];
  computed_at: string | null;
};

export type HistoryPanelProps = {
  patientId: string;
  patientName: string;
  summary: HPSummary;
  encounters: HPEncounterCard[];
};

const LS_KEY = 'ph3.panel_open';

export function HistoryPanel(props: HistoryPanelProps) {
  const [open, setOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Restore preference from localStorage after mount to avoid SSR mismatch.
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(LS_KEY);
      setOpen(v === '1');
    } catch {
      /* ignore — SSR-safe default is collapsed */
    }
    setHydrated(true);
  }, []);

  function persist(next: boolean) {
    setOpen(next);
    try {
      window.localStorage.setItem(LS_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  // Until hydrated, render the rail closed to match SSR output.
  const isOpen = hydrated && open;

  return (
    <>
      {/* Rail — always visible, at the left edge of viewport */}
      <button
        type="button"
        aria-label={isOpen ? 'Collapse history panel' : 'Expand history panel'}
        aria-expanded={isOpen}
        onClick={() => persist(!isOpen)}
        className="fixed left-0 top-1/2 z-30 -translate-y-1/2 rounded-r-lg border border-l-0 border-violet-200 bg-violet-50 px-1.5 py-3 text-violet-800 shadow-sm transition hover:bg-violet-100"
      >
        <span aria-hidden className="block text-base leading-none">
          {isOpen ? '◀' : '▶'}
        </span>
        <span className="mt-1 block text-[8px] font-semibold uppercase tracking-wider">
          {isOpen ? 'Hide' : 'Hx'}
        </span>
      </button>

      {/* Backdrop — only when open. Click to close. */}
      {isOpen && (
        <div
          aria-hidden
          className="fixed inset-0 z-20 bg-black/10"
          onClick={() => persist(false)}
        />
      )}

      {/* Slide-in panel */}
      <aside
        aria-hidden={!isOpen}
        className={`fixed left-0 top-0 z-20 flex h-screen w-[360px] flex-col border-r border-violet-200 bg-white shadow-lg transition-transform duration-200 ease-out ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <PanelHeader
          patientId={props.patientId}
          patientName={props.patientName}
          onClose={() => persist(false)}
        />
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <SummaryLine summary={props.summary} />
          <Problems problems={props.summary.problems} />
          <Allergies items={props.summary.allergies} />
          <RecentEncounters encounters={props.encounters} />
        </div>
        <PanelFooter computedAt={props.summary.computed_at} />
      </aside>
    </>
  );
}

// -----------------------------------------------------------------------------
// Sub-sections
// -----------------------------------------------------------------------------

function PanelHeader({
  patientId,
  patientName,
  onClose,
}: {
  patientId: string;
  patientName: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-violet-100 bg-violet-50/60 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-even-navy">
          {patientName}
        </p>
        <Link
          href={`/patients/${patientId}`}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 inline-block text-[10px] font-medium uppercase tracking-wider text-violet-800 hover:text-violet-900 hover:underline"
        >
          View full history →
        </Link>
      </div>
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="ml-2 rounded-md border border-even-ink-200 bg-white px-2 py-1 text-xs text-even-ink-500 hover:border-even-ink-300 hover:text-even-navy"
      >
        ✕
      </button>
    </div>
  );
}

function PanelFooter({ computedAt }: { computedAt: string | null }) {
  return (
    <div className="border-t border-violet-100 bg-violet-50/40 px-4 py-2 text-[10px] uppercase tracking-wider text-violet-800">
      AI summary{computedAt ? ` · computed ${timeAgo(computedAt)}` : ''}
    </div>
  );
}

function SummaryLine({ summary }: { summary: HPSummary }) {
  if (summary.status === 'missing') {
    return (
      <div className="mb-3 rounded-md border border-even-ink-200 bg-white px-3 py-2 text-xs text-even-ink-500">
        No AI summary yet — click <span className="font-mono">Recompute</span>{' '}
        on the longitudinal view.
      </div>
    );
  }
  if (summary.status === 'computing') {
    return (
      <div className="mb-3 rounded-md border border-even-ink-200 bg-even-ink-50 px-3 py-2 text-xs text-even-ink-600">
        Computing summary…
      </div>
    );
  }
  if (summary.status === 'failed' || !summary.summary_text) {
    return (
      <div className="mb-3 rounded-md border border-even-pink-200 bg-even-pink-50 px-3 py-2 text-xs text-even-pink-800">
        Summary unavailable. Try Recompute from the longitudinal view.
      </div>
    );
  }
  return (
    <p className="mb-3 text-sm leading-snug text-even-navy">
      {summary.summary_text}
    </p>
  );
}

function Problems({ problems }: { problems: HPProblem[] }) {
  if (problems.length === 0) return null;
  const top = problems.slice(0, 4);
  return (
    <div className="mb-3 rounded-md border border-even-ink-100 bg-white p-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-even-ink-500">
        Active problems
      </p>
      <ul className="space-y-1.5">
        {top.map((p, i) => (
          <li key={`${p.label}-${i}`} className="text-xs">
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500"
              />
              <span className="font-medium text-even-navy">{p.label ?? '—'}</span>
              {p.status && (
                <span className="text-[9px] uppercase tracking-wider text-even-ink-400">
                  · {p.status}
                </span>
              )}
            </div>
            {(p.current_meds?.length ?? 0) > 0 && (
              <div className="ml-3 text-[11px] text-even-ink-500">
                {(p.current_meds ?? []).join(', ')}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Allergies({ items }: { items: HPAllergy[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-3 rounded-md border border-even-pink-200 bg-even-pink-50 p-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-even-pink-800">
        ⚠ Allergies
      </p>
      <ul className="space-y-1">
        {items.map((a, i) => (
          <li key={`${a.allergen}-${i}`} className="text-xs">
            <div className="flex items-center gap-1.5">
              {!a.fromOwner && (
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500"
                />
              )}
              <span className="font-medium text-even-pink-900">{a.allergen}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecentEncounters({
  encounters,
}: {
  encounters: HPEncounterCard[];
}) {
  if (encounters.length === 0) {
    return (
      <div className="mb-3 rounded-md border border-dashed border-even-ink-200 bg-white px-3 py-2 text-xs text-even-ink-500">
        No prior encounters.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-even-ink-100 bg-white p-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-even-ink-500">
        Recent visits
      </p>
      <ol className="space-y-2">
        {encounters.slice(0, 5).map((e) => (
          <li key={e.id} className="text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-even-navy">{e.encounter_date}</span>
              {e.primary_code && (
                <span className="font-mono text-[10px] text-even-blue-700">
                  {e.primary_code}
                </span>
              )}
            </div>
            {(e.chief_complaint_chips?.length ?? 0) > 0 && (
              <div className="mt-0.5 flex flex-wrap gap-1">
                {(e.chief_complaint_chips ?? []).slice(0, 3).map((chip) => (
                  <span
                    key={chip}
                    className="inline-block rounded-full border border-even-ink-200 bg-white px-1.5 py-0.5 text-[9px] text-even-ink-700"
                  >
                    {chip}
                  </span>
                ))}
              </div>
            )}
            {e.disposition && (
              <div className="mt-0.5 text-[10px] uppercase tracking-wider text-even-ink-400">
                {e.disposition.replace(/_/g, ' ')}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'never';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
