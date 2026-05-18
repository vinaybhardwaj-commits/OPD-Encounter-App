'use client';

/**
 * <DictateButton /> — captures a short voice note, uploads it, gets a
 * transcript back, and (optionally) hands the transcript to the parent
 * so the section field can be auto-filled.
 *
 * Flow (M5.1):
 *   1. Idle. Tap → request mic permission, start MediaRecorder.
 *   2. Recording. Pulsing pink ring + MM:SS ticker. Tap again to stop.
 *   3. Saving. POST multipart (audio + section + duration) to
 *      /api/encounters/[id]/dictations. Server uploads to Blob,
 *      transcribes via Deepgram, returns the row + transcript.
 *   4. Done. Show "✓ MM:SS" briefly; if transcript came back, call
 *      onTranscript so the parent can insert it.
 *
 * Falls back gracefully if MediaRecorder / getUserMedia isn't available
 * (e.g. http context) — still posts a JSON-only row marking intent.
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
  onTranscript?: (transcript: string) => void;
  disabled?: boolean;
};

type State = 'idle' | 'asking' | 'recording' | 'saving' | 'saved' | 'error';

export function DictateButton({
  encounterId,
  section,
  onTranscript,
  disabled,
}: DictateButtonProps) {
  const [state, setState] = useState<State>('idle');
  const [seconds, setSeconds] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const startRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => () => {
    // On unmount, stop any in-progress stream
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (tickRef.current) clearInterval(tickRef.current);
  }, []);

  useEffect(() => {
    if (state !== 'saved') return;
    const t = setTimeout(() => setState('idle'), 2500);
    return () => clearTimeout(t);
  }, [state]);

  function preferredMime(): string {
    if (typeof MediaRecorder === 'undefined') return 'audio/webm';
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  async function start() {
    if (disabled || state === 'saving' || state === 'recording') return;
    setErrorMsg(null);

    // No MediaRecorder → JSON fallback (records intent only)
    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
      setState('error');
      setErrorMsg('Audio recording not supported in this browser.');
      return;
    }

    setState('asking');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = preferredMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => void uploadOnStop(rec.mimeType || mime);
      recorderRef.current = rec;
      rec.start();
      startRef.current = Date.now();
      setSeconds(0);
      setState('recording');
      tickRef.current = setInterval(() => {
        if (startRef.current == null) return;
        setSeconds(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);
    } catch (e) {
      setState('error');
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(
        msg.includes('Permission') || msg.includes('denied')
          ? 'Microphone permission denied.'
          : 'Could not start recording.',
      );
    }
  }

  function stop() {
    if (state !== 'recording') return;
    if (tickRef.current) clearInterval(tickRef.current);
    setState('saving');
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }

  async function uploadOnStop(mimeType: string) {
    if (startRef.current == null) return;
    const duration = Math.max(1, Math.floor((Date.now() - startRef.current) / 1000));
    startRef.current = null;

    try {
      const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
      const form = new FormData();
      form.append('audio', blob, `dictation.${(mimeType || 'audio/webm').split('/')[1].split(';')[0]}`);
      form.append('section', section);
      form.append('duration_seconds', String(duration));

      const res = await fetch(`/api/encounters/${encounterId}/dictations`, {
        method: 'POST',
        body: form,
      });
      const j = (await res.json()) as {
        ok?: boolean;
        dictation?: { transcript_text?: string | null; transcribe_error?: string | null };
        error?: string;
      };
      if (!res.ok || !j.ok) {
        setState('error');
        setErrorMsg(j.error ?? 'Save failed.');
        return;
      }
      setSeconds(duration);
      setState('saved');
      const transcript = j.dictation?.transcript_text;
      if (transcript && onTranscript) onTranscript(transcript);
      if (j.dictation?.transcribe_error) {
        setErrorMsg(`Audio saved, transcription failed: ${j.dictation.transcribe_error}`);
      }
    } catch (e) {
      setState('error');
      setErrorMsg(e instanceof Error ? e.message : 'Network error.');
    }
  }

  const label =
    state === 'recording'
      ? `${fmt(seconds)} · stop`
      : state === 'asking'
      ? 'mic…'
      : state === 'saving'
      ? 'transcribing…'
      : state === 'saved'
      ? `✓ ${fmt(seconds)}`
      : state === 'error'
      ? 'retry'
      : 'dictate';

  const tone =
    state === 'recording'
      ? 'border-even-pink-400 bg-even-pink-50 text-even-pink-800 ring-2 ring-even-pink-100 animate-pulse'
      : state === 'saved'
      ? 'border-even-blue-300 bg-even-blue-50 text-even-blue-700'
      : state === 'error'
      ? 'border-even-pink-300 bg-white text-even-pink-700'
      : state === 'saving' || state === 'asking'
      ? 'border-even-ink-300 bg-white text-even-ink-700'
      : 'border-even-ink-200 bg-white text-even-ink-600 hover:border-even-blue-300';

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={disabled || state === 'saving' || state === 'asking'}
        onClick={state === 'recording' ? stop : start}
        title={
          state === 'idle'
            ? 'Tap to record a quick voice note. Auto-transcribed via Deepgram and inserted into this section.'
            : undefined
        }
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-50 ${tone}`}
      >
        <MicIcon />
        <span>{label}</span>
      </button>
      {errorMsg && state !== 'recording' && (
        <span
          className="text-[10px] text-even-pink-700"
          title={errorMsg}
        >
          {errorMsg.length > 40 ? errorMsg.slice(0, 38) + '…' : errorMsg}
        </span>
      )}
    </span>
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
