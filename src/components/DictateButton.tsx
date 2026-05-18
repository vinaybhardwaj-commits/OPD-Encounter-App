'use client';

/**
 * <DictateButton /> — section-level dictation control.
 *
 * M3.3 scope: tap to start a "dictation session" (no audio capture
 * yet), tap again to stop. On stop, POSTs a section_dictations row
 * with `section` + `duration_seconds`. The row records *intent* —
 * Sprint 5 hooks in MediaRecorder + Vercel Blob + Deepgram so the
 * same component then actually captures + transcribes.
 *
 * Visual states:
 *   idle      → grey mic icon, "Dictate"
 *   recording → pulsing pink ring, MM:SS counter, "Stop"
 *   saving    → spinner
 *   saved     → ✓ tick, "Saved"
 *
 * Counts of prior dictations for this section live in the parent (it
 * fetches /api/encounters/[id]/dictations once) so the button doesn't
 * need to know about them.
 */
import { useEffect, useRef, useState } from 'react';

type Section =
  | 'chief_complaint'
  | 'exam_findings'
  | 'assessment'
  | 'prescription'
  | 'disposition';

export type DictateButtonProps = {
  encounterId: string;
  section: Section;
  /** Called after a successful POST. Parent can refresh counts. */
  onRecorded?: (dictation: { id: string; section: Section; duration_seconds: number }) => void;
  disabled?: boolean;
};

type State = 'idle' | 'recording' | 'saving' | 'saved' | 'error';

export function DictateButton({
  encounterId,
  section,
  onRecorded,
  disabled,
}: DictateButtonProps) {
  const [state, setState] = useState<State>('idle');
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (tickRef.current) clearInterval(tickRef.current);
  }, []);

  // Auto-revert "saved" → "idle" after 2s so the next dictation feels fresh
  useEffect(() => {
    if (state !== 'saved') return;
    const t = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(t);
  }, [state]);

  function start() {
    if (disabled || state === 'saving') return;
    startRef.current = Date.now();
    setSeconds(0);
    setState('recording');
    tickRef.current = setInterval(() => {
      if (startRef.current == null) return;
      setSeconds(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
  }

  async function stop() {
    if (state !== 'recording' || startRef.current == null) return;
    if (tickRef.current) clearInterval(tickRef.current);
    const duration = Math.max(1, Math.floor((Date.now() - startRef.current) / 1000));
    startRef.current = null;
    setState('saving');
    try {
      const res = await fetch(`/api/encounters/${encounterId}/dictations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, duration_seconds: duration }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        dictation?: { id: string };
        error?: string;
      };
      if (!res.ok || !j.ok) {
        setState('error');
        return;
      }
      setSeconds(duration);
      setState('saved');
      onRecorded?.({ id: j.dictation!.id, section, duration_seconds: duration });
    } catch {
      setState('error');
    }
  }

  const label =
    state === 'recording'
      ? `${fmt(seconds)} · stop`
      : state === 'saving'
      ? 'saving…'
      : state === 'saved'
      ? `✓ ${fmt(seconds)}`
      : state === 'error'
      ? 'try again'
      : 'dictate';

  const tone =
    state === 'recording'
      ? 'border-even-pink-400 bg-even-pink-50 text-even-pink-800 ring-2 ring-even-pink-100 animate-pulse'
      : state === 'saved'
      ? 'border-even-blue-300 bg-even-blue-50 text-even-blue-700'
      : state === 'error'
      ? 'border-even-pink-300 bg-white text-even-pink-700'
      : 'border-even-ink-200 bg-white text-even-ink-600 hover:border-even-blue-300';

  return (
    <button
      type="button"
      disabled={disabled || state === 'saving'}
      onClick={state === 'recording' ? stop : start}
      title={
        state === 'idle'
          ? 'Tap to record a quick voice note. Sprint 5 wires in real audio + transcription.'
          : undefined
      }
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-50 ${tone}`}
    >
      <MicIcon />
      <span>{label}</span>
    </button>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M5 12a7 7 0 0 0 14 0M12 19v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
