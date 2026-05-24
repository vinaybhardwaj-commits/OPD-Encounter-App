'use client';

/**
 * <EncounterTopBar /> — v4.0.1
 *
 * Replaces the original page header (Back-to-queue + VoiceQueryFab +
 * encounter number + status). Per the v4 PRD §5.1:
 *
 *   ← Queue   Patient Name · 37M · ENC-2026-014   ⏱ 03:06  🎙  ✨  ⋯
 *
 * - Sentence-case "Queue" link, no uppercase tracking-wide
 * - Patient identity is the bold center; status renders as a tiny
 *   colored dot before the name (gray / blue / amber / ink)
 * - Right side: timer (computed client-side), voice query (existing
 *   VoiceQueryFab), Ask side-panel toggle, more menu
 *
 * The "more menu" (⋯) is a placeholder for v4.0.x — it'll surface
 * Diagnostics workspace, Imaging, Flag handoff, History panel, etc.
 * in later sprints. For now it's a stub that opens nothing.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { VoiceQueryFab } from '../VoiceQueryFab';

type EncounterStatus =
  | 'registered'
  | 'at_triage'
  | 'waiting_for_doctor'
  | 'active'
  | 'paused_diagnostics'
  | 'ready_to_resume'
  | 'completed';

type StatusTone = { dot: string; label: string };

const STATUS_TONE: Record<EncounterStatus, StatusTone> = {
  registered: { dot: 'bg-even-ink-300', label: 'registered' },
  at_triage: { dot: 'bg-even-ink-300', label: 'at triage' },
  waiting_for_doctor: { dot: 'bg-even-ink-400', label: 'waiting' },
  active: { dot: 'bg-emerald-500', label: 'active' },
  paused_diagnostics: { dot: 'bg-amber-500', label: 'paused' },
  ready_to_resume: { dot: 'bg-even-blue', label: 'ready' },
  completed: { dot: 'bg-even-ink-200', label: 'completed' },
};

function formatElapsed(startedAtIso: string | null): string {
  if (!startedAtIso) return '—';
  const start = new Date(startedAtIso).getTime();
  if (Number.isNaN(start)) return '—';
  const elapsedSec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const m = Math.floor(elapsedSec / 60);
  const s = elapsedSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function EncounterTopBar({
  encounterId,
  encounterNumber,
  status,
  startedAt,
  patientName,
  patientAge,
  patientSex,
}: {
  encounterId: string;
  encounterNumber: string;
  status: EncounterStatus;
  startedAt: string | null;
  patientName: string;
  patientAge: number;
  patientSex: string;
}) {
  const [elapsed, setElapsed] = useState(() => formatElapsed(startedAt));

  useEffect(() => {
    if (status === 'completed') return;
    const id = setInterval(() => setElapsed(formatElapsed(startedAt)), 1000);
    return () => clearInterval(id);
  }, [startedAt, status]);

  const tone = STATUS_TONE[status];
  const showTimer = status !== 'completed' && startedAt;
  const showVoice = status !== 'completed';

  return (
    <header className="border-b border-even-ink-100 bg-white">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-3">
        {/* Left — back link */}
        <Link
          href="/dashboard"
          className="shrink-0 text-xs font-medium text-even-ink-500 hover:text-even-navy"
        >
          ← Queue
        </Link>

        {/* Center — patient identity with status dot */}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2 text-center text-sm">
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${tone.dot}`}
            title={tone.label}
            aria-label={`Status: ${tone.label}`}
          />
          <span className="truncate font-semibold text-even-navy">{patientName}</span>
          <span className="shrink-0 text-even-ink-500">·</span>
          <span className="shrink-0 font-mono text-xs text-even-ink-500">
            {patientAge}{patientSex}
          </span>
          <span className="shrink-0 text-even-ink-500">·</span>
          <span className="shrink-0 font-mono text-xs text-even-ink-400">
            {encounterNumber}
          </span>
        </div>

        {/* Right — timer + actions */}
        <div className="flex shrink-0 items-center gap-3 text-xs text-even-ink-500">
          {showTimer && (
            <span
              className="font-mono tabular-nums text-even-navy"
              title="Elapsed since encounter started"
            >
              ⏱ {elapsed}
            </span>
          )}
          {showVoice && <VoiceQueryFab encounterId={encounterId} />}
          {/* The ✨ Ask toggle + ⋯ more menu are placeholders for v4.0.8/4.0.9.
              For v4.0.1 the side panel is already always-rendered, and the
              imaging/handoff/workspace actions remain in EncounterEditor's
              existing action bar. */}
        </div>
      </div>
    </header>
  );
}
