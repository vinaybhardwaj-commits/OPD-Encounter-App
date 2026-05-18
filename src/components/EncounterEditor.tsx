'use client';

/**
 * <EncounterEditor /> — the working surface of an OPD encounter.
 *
 * Sprint 2 (M2.3) scope: chief complaint, vitals, exam findings,
 * assessment, disposition, Submit & finish. Auto-save 800ms after
 * the doctor pauses typing. The "saved" indicator quietly tracks
 * whether the local state matches the server.
 *
 * Sprints 3-7 add: CC chips + ICD-10 typeahead + section dictation
 * (S3), prescription compose row (S4), recording (S5), pause/send to
 * diagnostics (S6), confirmation modal + PDF + Twilio (S7).
 *
 * Read-only when status is 'completed'. Editable in 'active' and
 * 'ready_to_resume'. 'paused_diagnostics' is editable too (doctor
 * may want to update notes while waiting for the test) but the
 * Submit button is gated until the encounter is resumed (Sprint 6).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Vitals = {
  bp_sys?: number | '';
  bp_dia?: number | '';
  hr?: number | '';
  rr?: number | '';
  temp_c?: number | '';
  spo2?: number | '';
};

export type Disposition =
  | 'discharge'
  | 'follow_up'
  | 'refer'
  | 'diagnostics'
  | 'admit'
  | 'vaccinate';

export type EncounterEditable = {
  id: string;
  encounter_number: string;
  status:
    | 'active'
    | 'paused_diagnostics'
    | 'ready_to_resume'
    | 'completed';
  started_at: string;
  pending_diagnostic_test: string | null;
  chief_complaint_text: string | null;
  exam_findings: string | null;
  vitals: Vitals | null;
  assessment_text: string | null;
  disposition: Disposition | null;
  follow_up_days: number | null;
  referral_target: string | null;
};

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const DISPOSITIONS: { value: Disposition; label: string; hint: string }[] = [
  { value: 'discharge', label: 'Discharge', hint: 'Done — patient leaves.' },
  { value: 'follow_up', label: 'Follow-up', hint: 'See again later.' },
  { value: 'refer', label: 'Refer', hint: 'Send to specialist.' },
  { value: 'diagnostics', label: 'Diagnostics', hint: 'Order tests.' },
  { value: 'admit', label: 'Admit', hint: 'Inpatient.' },
  { value: 'vaccinate', label: 'Vaccinate', hint: 'Routine immunisation.' },
];

export function EncounterEditor({ initial }: { initial: EncounterEditable }) {
  const router = useRouter();
  const readOnly = initial.status === 'completed';
  const submitGated = initial.status === 'paused_diagnostics';

  const [cc, setCc] = useState(initial.chief_complaint_text ?? '');
  const [exam, setExam] = useState(initial.exam_findings ?? '');
  const [assessment, setAssessment] = useState(initial.assessment_text ?? '');
  const [vitals, setVitals] = useState<Vitals>(initial.vitals ?? {});
  const [disposition, setDisposition] = useState<Disposition | null>(initial.disposition);
  const [followUpDays, setFollowUpDays] = useState<number | ''>(initial.follow_up_days ?? '');
  const [referralTarget, setReferralTarget] = useState<string>(initial.referral_target ?? '');

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [timerNow, setTimerNow] = useState(() => Date.now());

  // Timer that updates each second while encounter is active
  useEffect(() => {
    if (readOnly) return;
    const t = setInterval(() => setTimerNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [readOnly]);

  const elapsed = useMemo(() => {
    const start = new Date(initial.started_at).getTime();
    const sec = Math.max(0, Math.floor((timerNow - start) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }, [timerNow, initial.started_at]);

  // Build the canonical body for PATCH from current state
  const buildBody = useCallback(() => {
    const cleanVitals: Vitals = {};
    (Object.keys(vitals) as (keyof Vitals)[]).forEach((k) => {
      const v = vitals[k];
      if (v !== '' && v !== undefined && v !== null) cleanVitals[k] = v;
    });
    return {
      chief_complaint_text: cc || null,
      exam_findings: exam || null,
      vitals: Object.keys(cleanVitals).length > 0 ? cleanVitals : null,
      assessment_text: assessment || null,
      disposition: disposition,
      follow_up_days: disposition === 'follow_up' && followUpDays !== '' ? Number(followUpDays) : null,
      referral_target: disposition === 'refer' ? referralTarget || null : null,
    };
  }, [cc, exam, assessment, vitals, disposition, followUpDays, referralTarget]);

  // Debounced auto-save
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipFirstRef = useRef(true);
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
        const res = await fetch(`/api/encounters/${initial.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody()),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSaveState('saved');
        setLastSavedAt(Date.now());
      } catch {
        setSaveState('error');
      }
    }, 800);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [cc, exam, assessment, vitals, disposition, followUpDays, referralTarget, initial.id, readOnly, buildBody]);

  async function onSubmit() {
    if (readOnly || submitting || submitGated || !disposition) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Flush any pending save first
      if (saveState === 'dirty' || saveState === 'saving') {
        await fetch(`/api/encounters/${initial.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody()),
        });
      }
      const res = await fetch(`/api/encounters/${initial.id}/complete`, {
        method: 'POST',
      });
      const j = (await res.json()) as { ok?: boolean; error?: string; detail?: string };
      if (!res.ok || !j.ok) {
        setSubmitError(j.detail ?? j.error ?? 'Could not finish encounter.');
        return;
      }
      router.push('/dashboard');
      router.refresh();
    } catch {
      setSubmitError('Network error. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const saveLabel =
    saveState === 'idle'
      ? ''
      : saveState === 'dirty'
      ? '· editing'
      : saveState === 'saving'
      ? '· saving…'
      : saveState === 'error'
      ? '· save failed'
      : `· saved${lastSavedAt ? ` ${new Date(lastSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`;

  const saveTone =
    saveState === 'error' ? 'text-even-pink-700' : 'text-even-ink-400';

  return (
    <div className="space-y-8">
      {/* Timer + recording placeholder + save indicator */}
      <div className="flex items-center justify-between text-xs text-even-ink-500">
        <div className="flex items-center gap-4">
          <span className="font-mono text-sm tabular-nums text-even-navy">
            ⏱ {readOnly ? '—' : elapsed}
          </span>
          <span className="text-even-ink-400">
            Ambient recording · Sprint 5
          </span>
        </div>
        <span className={`text-[11px] tabular-nums ${saveTone}`}>{saveLabel}</span>
      </div>

      {initial.status === 'ready_to_resume' && (
        <div className="rounded-lg border border-even-blue-200 bg-even-blue-50 p-3 text-xs text-even-navy">
          Diagnostic{' '}
          <span className="font-medium">{initial.pending_diagnostic_test}</span>{' '}
          back. Encounter ready to continue. Pause / resume controls ship in
          Sprint 6.
        </div>
      )}

      {initial.status === 'paused_diagnostics' && (
        <div className="rounded-lg border border-even-pink-200 bg-even-pink-50 p-3 text-xs text-even-navy">
          Encounter paused — awaiting{' '}
          <span className="font-medium">{initial.pending_diagnostic_test}</span>.
          You can still update notes; Submit is held until the encounter is resumed.
        </div>
      )}

      <Section label="Chief complaint" desc="What the patient is here for. Sprint 3 adds chip shortcuts + dictation.">
        <textarea
          value={cc}
          onChange={(e) => setCc(e.target.value)}
          disabled={readOnly}
          rows={2}
          placeholder="e.g., Sore throat 3 days, low-grade fever"
          className={textareaCls}
        />
      </Section>

      <Section label="Vitals" desc="Optional — fill what was measured.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <VitalInput label="BP sys" suffix="mmHg" value={vitals.bp_sys ?? ''} onChange={(v) => setVitals({ ...vitals, bp_sys: v })} readOnly={readOnly} />
          <VitalInput label="BP dia" suffix="mmHg" value={vitals.bp_dia ?? ''} onChange={(v) => setVitals({ ...vitals, bp_dia: v })} readOnly={readOnly} />
          <VitalInput label="HR" suffix="bpm" value={vitals.hr ?? ''} onChange={(v) => setVitals({ ...vitals, hr: v })} readOnly={readOnly} />
          <VitalInput label="RR" suffix="/min" value={vitals.rr ?? ''} onChange={(v) => setVitals({ ...vitals, rr: v })} readOnly={readOnly} />
          <VitalInput label="Temp" suffix="°C" step="0.1" value={vitals.temp_c ?? ''} onChange={(v) => setVitals({ ...vitals, temp_c: v })} readOnly={readOnly} />
          <VitalInput label="SpO₂" suffix="%" value={vitals.spo2 ?? ''} onChange={(v) => setVitals({ ...vitals, spo2: v })} readOnly={readOnly} />
        </div>
      </Section>

      <Section label="Exam findings" desc="What you observed.">
        <textarea
          value={exam}
          onChange={(e) => setExam(e.target.value)}
          disabled={readOnly}
          rows={3}
          placeholder="e.g., Mildly inflamed pharynx, no exudate, afebrile on exam."
          className={textareaCls}
        />
      </Section>

      <Section label="Assessment" desc="Impression. Sprint 3 adds ICD-10 typeahead.">
        <textarea
          value={assessment}
          onChange={(e) => setAssessment(e.target.value)}
          disabled={readOnly}
          rows={2}
          placeholder="e.g., Acute pharyngitis, likely viral."
          className={textareaCls}
        />
      </Section>

      <Section label="Prescription" desc="Sprint 4 — drug rows + smart defaults.">
        <div className="rounded-lg border border-dashed border-even-ink-200 bg-white p-4 text-center text-xs text-even-ink-400">
          Compose flow ships in Sprint 4. The typeahead at{' '}
          <span className="font-mono">/dashboard/drugs</span> previews the
          drug picker.
        </div>
      </Section>

      <Section label="Disposition" desc="Required to submit." required>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {DISPOSITIONS.map((d) => {
            const selected = disposition === d.value;
            return (
              <button
                key={d.value}
                type="button"
                disabled={readOnly}
                onClick={() => setDisposition(d.value)}
                aria-pressed={selected}
                className={`rounded-xl border p-3 text-left transition disabled:cursor-not-allowed ${
                  selected
                    ? 'border-even-blue bg-even-blue text-white shadow-sm'
                    : 'border-even-ink-200 bg-white text-even-navy hover:border-even-blue-300'
                }`}
              >
                <div className="text-sm font-semibold">{d.label}</div>
                <div className={`text-[11px] ${selected ? 'text-white/80' : 'text-even-ink-500'}`}>
                  {d.hint}
                </div>
              </button>
            );
          })}
        </div>

        {disposition === 'follow_up' && (
          <div className="mt-4 flex items-center gap-2">
            <label className="text-xs text-even-ink-600" htmlFor="follow_up_days">
              Follow up in
            </label>
            <input
              id="follow_up_days"
              type="number"
              min={1}
              max={365}
              disabled={readOnly}
              value={followUpDays}
              onChange={(e) => setFollowUpDays(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-24 rounded-md border border-even-ink-200 bg-white px-3 py-1.5 text-sm text-even-navy focus:border-even-blue focus:outline-none focus:ring-2 focus:ring-even-blue-100"
            />
            <span className="text-xs text-even-ink-500">days</span>
          </div>
        )}
        {disposition === 'refer' && (
          <div className="mt-4">
            <label className="mb-1 block text-xs text-even-ink-600" htmlFor="referral_target">
              Refer to
            </label>
            <input
              id="referral_target"
              type="text"
              disabled={readOnly}
              value={referralTarget}
              onChange={(e) => setReferralTarget(e.target.value)}
              placeholder="e.g., Cardiology · Dr. Iyer"
              className="w-full rounded-md border border-even-ink-200 bg-white px-3 py-1.5 text-sm text-even-navy focus:border-even-blue focus:outline-none focus:ring-2 focus:ring-even-blue-100"
            />
          </div>
        )}
      </Section>

      {!readOnly && (
        <div className="sticky bottom-0 -mx-6 border-t border-even-ink-100 bg-white/95 px-6 py-4 backdrop-blur">
          <div className="flex items-center justify-between gap-4">
            <div>
              {submitError && (
                <p className="text-xs text-even-pink-700">{submitError}</p>
              )}
              {!disposition && (
                <p className="text-xs text-even-ink-500">
                  Pick a disposition to submit.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onSubmit}
              disabled={!disposition || submitting || submitGated}
              className="rounded-lg bg-even-blue px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 hover:bg-even-blue-700 focus:outline-none focus:ring-2 focus:ring-even-blue-100"
              title={submitGated ? 'Paused for diagnostics — resume first (Sprint 6).' : ''}
            >
              {submitting ? 'Finishing…' : 'Submit & finish'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const textareaCls =
  'w-full rounded-lg border border-even-ink-200 bg-white px-3 py-2 text-sm text-even-navy placeholder-even-ink-300 focus:border-even-blue focus:outline-none focus:ring-2 focus:ring-even-blue-100 disabled:bg-even-ink-50 disabled:text-even-ink-500';

function Section({
  label,
  desc,
  required,
  children,
}: {
  label: string;
  desc?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-even-navy">
          {label}{' '}
          {required && <span className="ml-1 text-even-pink-700">*</span>}
        </h2>
        {desc && <p className="text-[11px] text-even-ink-400">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

function VitalInput({
  label,
  suffix,
  value,
  onChange,
  step,
  readOnly,
}: {
  label: string;
  suffix: string;
  value: number | '';
  onChange: (v: number | '') => void;
  step?: string;
  readOnly?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wider text-even-ink-500">
        {label}
      </span>
      <div className="flex items-center gap-1 rounded-md border border-even-ink-200 bg-white pr-2 focus-within:border-even-blue focus-within:ring-2 focus-within:ring-even-blue-100">
        <input
          type="number"
          step={step}
          disabled={readOnly}
          value={value}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          className="w-full bg-transparent px-3 py-1.5 text-sm text-even-navy focus:outline-none disabled:text-even-ink-500"
        />
        <span className="text-[10px] text-even-ink-400">{suffix}</span>
      </div>
    </label>
  );
}
