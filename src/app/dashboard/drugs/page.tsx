'use client';

/**
 * /dashboard/drugs — typeahead playground.
 *
 * Lets V sanity-test the M1.3 typeahead end-to-end before Sprint 4
 * integrates it into the encounter screen's prescription compose row.
 * Behavior here intentionally mirrors what a "drug picker inside a Rx
 * row" will feel like: type, pick, see the row materialise, repeat.
 *
 * The page is a client component to own selection state; the layout
 * around it stays as the M0.4 dashboard shell.
 */
import { useState } from 'react';
import Link from 'next/link';
import { DrugTypeahead } from '@/components/DrugTypeahead';
import type { DrugSearchResult } from '@/lib/types';

type Pick = DrugSearchResult & { picked_at: number };

export default function DrugsPage() {
  const [picks, setPicks] = useState<Pick[]>([]);

  function add(drug: DrugSearchResult) {
    setPicks((p) => [{ ...drug, picked_at: Date.now() }, ...p]);
  }

  function removeAt(i: number) {
    setPicks((p) => p.filter((_, idx) => idx !== i));
  }

  function clearAll() {
    setPicks([]);
  }

  return (
    <main className="min-h-screen bg-even-white-DEFAULT">
      <header className="border-b border-even-ink-100 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="flex items-center gap-3">
              <div
                aria-hidden
                className="h-7 w-7 rounded-full bg-even-blue ring-4 ring-even-blue-100"
              />
              <span className="text-xs font-medium uppercase tracking-[0.18em] text-even-navy">
                Even OPD
              </span>
            </Link>
          </div>
          <Link
            href="/dashboard"
            className="text-xs font-medium uppercase tracking-wider text-even-ink-500 hover:text-even-navy"
          >
            ← Dashboard
          </Link>
        </div>
      </header>

      <section className="mx-auto max-w-3xl px-6 py-10">
        <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-even-blue-700">
          Sprint 1 · M1.3
        </p>
        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-even-navy">
          Drug typeahead
        </h1>
        <p className="mb-8 text-sm text-even-ink-600">
          Type a brand or generic name. Use ↑ ↓ to navigate and Enter to
          pick. 2,174 drugs from the Pharmacy Formulary 2026 are indexed.
        </p>

        <DrugTypeahead onSelect={add} autoFocus />

        <div className="mt-10 flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wider text-even-ink-500">
            Picks · {picks.length}
          </h2>
          {picks.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="text-xs font-medium uppercase tracking-wider text-even-ink-400 hover:text-even-pink-700"
            >
              Clear all
            </button>
          )}
        </div>

        {picks.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-even-ink-200 bg-white p-6 text-center text-xs text-even-ink-400">
            Picks land here. Try{' '}
            <span className="font-mono text-even-navy">para</span>,{' '}
            <span className="font-mono text-even-navy">cefur</span>, or{' '}
            <span className="font-mono text-even-navy">insulin</span>.
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {picks.map((p, i) => (
              <li
                key={`${p.item_code}-${p.picked_at}`}
                className="rounded-xl border border-even-ink-200 bg-white p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm font-semibold text-even-navy">
                        {p.brand_name}
                      </span>
                      {p.strength && (
                        <span className="text-xs text-even-ink-500">
                          {p.strength}
                        </span>
                      )}
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                          p.schedule_dc === 'X'
                            ? 'bg-even-pink-200 text-even-pink-900'
                            : p.schedule_dc === 'H1'
                            ? 'bg-even-pink-100 text-even-pink-800'
                            : p.schedule_dc === 'H'
                            ? 'bg-even-ink-100 text-even-ink-700'
                            : 'bg-even-ink-50 text-even-ink-500'
                        }`}
                      >
                        {p.schedule_dc}
                      </span>
                      {p.is_high_risk && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-even-pink-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-even-pink-800"
                          title="ISMP high-alert medication"
                        >
                          <span aria-hidden>⚠</span> High risk
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-even-ink-600">
                      {p.generic_name} · {p.dosage_form} ·{' '}
                      <span className="text-even-ink-400">
                        {p.major_grouping}
                      </span>
                    </div>
                    {p.lasa_alternates.length > 0 && (
                      <div className="mt-1.5 text-[11px] text-even-ink-500">
                        <span className="font-medium uppercase tracking-wider text-even-ink-400">
                          LASA:
                        </span>{' '}
                        {p.lasa_alternates.join(', ')}
                      </div>
                    )}
                    <div className="mt-2 font-mono text-[10px] text-even-ink-300">
                      {p.item_code} · score {p.score.toFixed(2)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    className="text-xs font-medium uppercase tracking-wider text-even-ink-400 hover:text-even-pink-700"
                    aria-label={`Remove ${p.brand_name}`}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-12 text-[11px] text-even-ink-400">
          Sprint 4 drops this component into the encounter screen&apos;s
          prescription compose row. The schedule chip, high-risk badge, and
          LASA list all carry into the real Rx flow.
        </p>
      </section>
    </main>
  );
}
