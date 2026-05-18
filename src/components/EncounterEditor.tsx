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
import { CC_CHIPS } from '@/lib/cc-chips';
import { lookupIcd10 } from '@/lib/icd10';
import { Icd10Typeahead } from './Icd10Typeahead';
import { DictateButton } from './DictateButton';
import { PrescriptionCompose } from './PrescriptionCompose';
import type { PrescriptionLine } from './DrugRow';
import { AmbientRecorder } from './AmbientRecorder';
import { TranscriptViewer, type TranscriptViewerHandle } from './TranscriptViewer';
import { SendToDiagnosticsModal } from './SendToDiagnosticsModal';
import { SubmitConfirmModal } from './SubmitConfirmModal';

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
  chief_complaint_chips: string[] | null;
  chief_complaint_text: string | null;
  exam_findings: string | null;
  vitals: Vitals | null;
  assessment_codes: string[] | null;
  assessment_text: string | null;
  disposition: Disposition | null;
  follow_up_days: number | null;
  referral_target: string | null;
  disposition_label_override: string | null;
  prescription_lines: PrescriptionLine[];
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

export type EncounterPatient = {
  name: string;
  mrn: string;
  age_years: number;
  sex: string;
  phone_e164: string | null;
};

/**
 * PH.4 — patient-specific smartening fed by the cached Qwen summary.
 * Empty arrays mean "no AI guidance, fall back to default order".
 */
export type EncounterAi = {
  cc_chip_rankings: string[];
  cc_chip_additions: string[];
  disposition_recommendation: string | null;
  disposition_additions: string[];
};

const AI_EMPTY: EncounterAi = {
  cc_chip_rankings: [],
  cc_chip_additions: [],
  disposition_recommendation: null,
  disposition_additions: [],
};

export function EncounterEditor({
  initial,
  patient,
  ai,
}: {
  initial: EncounterEditable;
  patient: EncounterPatient;
  ai?: EncounterAi;
}) {
  const aiSafe: EncounterAi = ai ?? AI_EMPTY;
  const router = useRouter();
  const readOnly = initial.status === 'completed';
  const submitGated = initial.status === 'paused_diagnostics';
  const canSendToDiagnostics =
    initial.status === 'active' || initial.status === 'ready_to_resume';
  const [diagModalOpen, setDiagModalOpen] = useState(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);

  const [ccChips, setCcChips] = useState<string[]>(initial.chief_complaint_chips ?? []);
  const [cc, setCc] = useState(initial.chief_complaint_text ?? '');
  const [exam, setExam] = useState(initial.exam_findings ?? '');
  const [assessmentCodes, setAssessmentCodes] = useState<string[]>(initial.assessment_codes ?? []);
  const [assessment, setAssessment] = useState(initial.assessment_text ?? '');
  const [vitals, setVitals] = useState<Vitals>(initial.vitals ?? {});
  const [disposition, setDisposition] = useState<Disposition | null>(initial.disposition);
  const [followUpDays, setFollowUpDays] = useState<number | ''>(initial.follow_up_days ?? '');
  const [referralTarget, setReferralTarget] = useState<string>(initial.referral_target ?? '');
  const [dispositionLabel, setDispositionLabel] = useState<string | null>(
    initial.disposition_label_override ?? null,
  );

  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [timerNow, setTimerNow] = useState(() => Date.now());
  const transcriptRef = useRef<TranscriptViewerHandle | null>(null);

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
      chief_complaint_chips: ccChips.length > 0 ? ccChips : null,
      chief_complaint_text: cc || null,
      exam_findings: exam || null,
      vitals: Object.keys(cleanVitals).length > 0 ? cleanVitals : null,
      assessment_codes: assessmentCodes.length > 0 ? assessmentCodes : null,
      assessment_text: assessment || null,
      disposition: disposition,
      follow_up_days: disposition === 'follow_up' && followUpDays !== '' ? Number(followUpDays) : null,
      referral_target: disposition === 'refer' ? referralTarget || null : null,
      disposition_label_override: dispositionLabel,
    };
  }, [ccChips, cc, exam, assessmentCodes, assessment, vitals, disposition, followUpDays, referralTarget, dispositionLabel]);

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
  }, [ccChips, cc, exam, assessmentCodes, assessment, vitals, disposition, followUpDays, referralTarget, dispositionLabel, initial.id, readOnly, buildBody]);

  async function onSubmit() {
    if (readOnly || submitting || submitGated || !disposition) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Flush any pending save before opening the confirm modal — the
      // modal's /complete + /dispatch chain reads server-side state, so
      // we want everything persisted first.
      if (saveState === 'dirty' || saveState === 'saving') {
        await fetch(`/api/encounters/${initial.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody()),
        });
      }
      setConfirmModalOpen(true);
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
      {/* Timer + ambient recorder + save indicator */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-even-ink-500">
        <div className="flex items-center gap-4">
          <span className="font-mono text-sm tabular-nums text-even-navy">
            ⏱ {readOnly ? '—' : elapsed}
          </span>
          {!readOnly && (
            <AmbientRecorder
              encounterId={initial.id}
              onSnippetSaved={() => transcriptRef.current?.refresh()}
            />
          )}
        </div>
        <span className={`text-[11px] tabular-nums ${saveTone}`}>{saveLabel}</span>
      </div>

      {initial.status === 'ready_to_resume' && (
        <ResumeBanner
          encounterId={initial.id}
          test={initial.pending_diagnostic_test}
        />
      )}

      {initial.status === 'paused_diagnostics' && (
        <div className="rounded-lg border border-even-pink-200 bg-even-pink-50 p-3 text-xs text-even-navy">
          Encounter paused — awaiting{' '}
          <span className="font-medium">{initial.pending_diagnostic_test}</span>.
          You can still update notes; Submit is held until the encounter is
          back as Ready to resume.
        </div>
      )}

      <Section
        label="Chief complaint"
        desc="Tap chips for the common shortcuts. Add detail in the textarea."
        dictate={
          !readOnly
            ? {
                encounterId: initial.id,
                section: 'chief_complaint',
                onTranscript: (t) => setCc((cur) => appendTranscript(cur, t)),
              }
            : undefined
        }
      >
        <CcChipGrid
          selected={ccChips}
          onToggle={(label) =>
            setCcChips((cur) =>
              cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
            )
          }
          readOnly={readOnly}
          ccRankings={aiSafe.cc_chip_rankings}
          ccAdditions={aiSafe.cc_chip_additions}
        />
        <textarea
          value={cc}
          onChange={(e) => setCc(e.target.value)}
          disabled={readOnly}
          rows={2}
          placeholder="e.g., Sore throat 3 days, low-grade fever"
          className={`mt-3 ${textareaCls}`}
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

      <Section
        label="Exam findings"
        desc="What you observed."
        dictate={
          !readOnly
            ? {
                encounterId: initial.id,
                section: 'exam_findings',
                onTranscript: (t) => setExam((cur) => appendTranscript(cur, t)),
              }
            : undefined
        }
      >
        <textarea
          value={exam}
          onChange={(e) => setExam(e.target.value)}
          disabled={readOnly}
          rows={3}
          placeholder="e.g., Mildly inflamed pharynx, no exudate, afebrile on exam."
          className={textareaCls}
        />
      </Section>

      <Section
        label="Assessment"
        desc="Impression + ICD-10 codes."
        dictate={
          !readOnly
            ? {
                encounterId: initial.id,
                section: 'assessment',
                onTranscript: (t) => setAssessment((cur) => appendTranscript(cur, t)),
              }
            : undefined
        }
      >
        {assessmentCodes.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {assessmentCodes.map((code) => {
              const label = lookupIcd10(code);
              return (
                <span
                  key={code}
                  className="inline-flex items-center gap-1.5 rounded-full bg-even-blue-50 px-2.5 py-1 text-[11px] font-medium text-even-blue-800 ring-1 ring-even-blue-200"
                  title={label}
                >
                  <span className="font-mono font-semibold">{code}</span>
                  {label && (
                    <span className="hidden text-even-blue-700 sm:inline">
                      {label}
                    </span>
                  )}
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() =>
                        setAssessmentCodes((cur) => cur.filter((c) => c !== code))
                      }
                      aria-label={`Remove ${code}`}
                      className="rounded-full text-even-blue-500 hover:text-even-pink-700"
                    >
                      ×
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        )}
        {!readOnly && (
          <div className="mb-3">
            <Icd10Typeahead
              excludeCodes={assessmentCodes}
              onSelect={(item) =>
                setAssessmentCodes((cur) =>
                  cur.includes(item.code) ? cur : [...cur, item.code],
                )
              }
            />
          </div>
        )}
        <textarea
          value={assessment}
          onChange={(e) => setAssessment(e.target.value)}
          disabled={readOnly}
          rows={2}
          placeholder="e.g., Acute pharyngitis, likely viral."
          className={textareaCls}
        />
      </Section>

      <Section
        label="Prescription"
        desc="Add drugs; chips fill from defaults. Tap to override."
        dictate={!readOnly ? { encounterId: initial.id, section: 'prescription' } : undefined}
      >
        <PrescriptionCompose
          encounterId={initial.id}
          initialLines={initial.prescription_lines ?? []}
          readOnly={readOnly}
        />
      </Section>

      <Section label="Disposition" desc="Required to submit." required>
        {(() => {
          // PH.4: re-order the 6 standard buttons so the AI-recommended
          // one is leftmost, and stamp it with a violet dot.
          const aiRec = aiSafe.disposition_recommendation;
          const ordered = aiRec
            ? [
                ...DISPOSITIONS.filter((d) => d.value === aiRec),
                ...DISPOSITIONS.filter((d) => d.value !== aiRec),
              ]
            : DISPOSITIONS;
          return (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {ordered.map((d) => {
                const selected = disposition === d.value && !dispositionLabel;
                const isAi = aiRec === d.value;
                return (
                  <button
                    key={d.value}
                    type="button"
                    disabled={readOnly}
                    onClick={() => {
                      setDisposition(d.value);
                      setDispositionLabel(null);
                    }}
                    aria-pressed={selected}
                    className={`relative rounded-xl border p-3 text-left transition disabled:cursor-not-allowed ${
                      selected
                        ? 'border-even-blue bg-even-blue text-white shadow-sm'
                        : 'border-even-ink-200 bg-white text-even-navy hover:border-even-blue-300'
                    }`}
                  >
                    {isAi && (
                      <span
                        aria-label="AI-recommended"
                        className={`absolute right-2 top-2 inline-block h-1.5 w-1.5 rounded-full ${
                          selected ? 'bg-white' : 'bg-violet-500'
                        }`}
                      />
                    )}
                    <div className="text-sm font-semibold">{d.label}</div>
                    <div className={`text-[11px] ${selected ? 'text-white/80' : 'text-even-ink-500'}`}>
                      {d.hint}
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })()}

        {aiSafe.disposition_additions.length > 0 && (
          <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50/60 p-2">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-800">
              <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-violet-500" />
              For this patient
            </p>
            <div className="flex flex-wrap gap-2">
              {aiSafe.disposition_additions.map((label) => {
                const selected = dispositionLabel === label;
                return (
                  <button
                    key={`disp-add-${label}`}
                    type="button"
                    disabled={readOnly}
                    onClick={() => {
                      // Patient-specific dispositions map to 'refer' under
                      // the hood (most are specialist hand-offs), with
                      // the override label persisted for the PDF.
                      setDisposition('refer');
                      setDispositionLabel(label);
                      // If the addition looks like "Refer to Dr. X · Spec",
                      // pre-fill the referral target with the part after
                      // "Refer to " so the doctor doesn't have to retype.
                      const m = /^Refer to\s+(.+)$/i.exec(label);
                      if (m) setReferralTarget(m[1]);
                    }}
                    aria-pressed={selected}
                    className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-left transition disabled:cursor-not-allowed ${
                      selected
                        ? 'border-violet-500 bg-violet-600 text-white shadow-sm'
                        : 'border-violet-300 bg-white text-violet-900 hover:border-violet-500'
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        selected ? 'bg-white' : 'bg-violet-500'
                      }`}
                    />
                    <span className="text-xs font-semibold">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

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

      <TranscriptViewer ref={transcriptRef} encounterId={initial.id} />

      {!readOnly && (
        <div className="sticky bottom-0 -mx-6 border-t border-even-ink-100 bg-white/95 px-6 py-4 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              {submitError && (
                <p className="text-xs text-even-pink-700">{submitError}</p>
              )}
              {!disposition && !submitGated && (
                <p className="text-xs text-even-ink-500">
                  Pick a disposition to submit.
                </p>
              )}
              {submitGated && (
                <p className="text-xs text-even-ink-500">
                  Paused for diagnostics — submit unlocks once the encounter is back as Ready to resume.
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {canSendToDiagnostics && (
                <button
                  type="button"
                  onClick={() => setDiagModalOpen(true)}
                  className="rounded-lg border border-even-pink-300 bg-white px-4 py-2.5 text-sm font-semibold text-even-pink-800 transition hover:bg-even-pink-50"
                >
                  Send to diagnostics
                </button>
              )}
              <button
                type="button"
                onClick={onSubmit}
                disabled={!disposition || submitting || submitGated}
                className="rounded-lg bg-even-blue px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 hover:bg-even-blue-700 focus:outline-none focus:ring-2 focus:ring-even-blue-100"
                title={submitGated ? 'Encounter is paused — resume first.' : ''}
              >
                {submitting ? 'Finishing…' : 'Submit & finish'}
              </button>
            </div>
          </div>
        </div>
      )}

      <SendToDiagnosticsModal
        encounterId={initial.id}
        patientName={patient.name}
        open={diagModalOpen}
        onClose={() => setDiagModalOpen(false)}
      />

      <SubmitConfirmModal
        open={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
        encounterId={initial.id}
        patient={{
          name: patient.name,
          age_years: patient.age_years,
          sex: patient.sex,
          mrn: patient.mrn,
          phone_e164: patient.phone_e164,
        }}
        assessment={{
          text: assessment || null,
          codes: assessmentCodes,
        }}
        disposition={disposition}
        follow_up_days={typeof followUpDays === 'number' ? followUpDays : null}
        referral_target={referralTarget || null}
      />
    </div>
  );
}

const textareaCls =
  'w-full rounded-lg border border-even-ink-200 bg-white px-3 py-2 text-sm text-even-navy placeholder-even-ink-300 focus:border-even-blue focus:outline-none focus:ring-2 focus:ring-even-blue-100 disabled:bg-even-ink-50 disabled:text-even-ink-500';

function Section({
  label,
  desc,
  required,
  dictate,
  children,
}: {
  label: string;
  desc?: string;
  required?: boolean;
  dictate?: {
    encounterId: string;
    section:
      | 'chief_complaint'
      | 'exam_findings'
      | 'assessment'
      | 'prescription'
      | 'disposition';
    onTranscript?: (t: string) => void;
  };
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-even-navy">
            {label}{' '}
            {required && <span className="ml-1 text-even-pink-700">*</span>}
          </h2>
          {dictate && (
            <DictateButton
              encounterId={dictate.encounterId}
              section={dictate.section}
              onTranscript={dictate.onTranscript}
            />
          )}
        </div>
        {desc && <p className="text-[11px] text-even-ink-400">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

function ResumeBanner({
  encounterId,
  test,
}: {
  encounterId: string;
  test: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onResume() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/encounters/${encounterId}/resume`, {
        method: 'POST',
      });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) {
        setError(j.error ?? 'Could not resume.');
        return;
      }
      router.refresh();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-even-blue-200 bg-even-blue-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-even-blue-700">
            Ready to resume
          </p>
          <p className="mt-0.5 text-xs text-even-navy">
            Diagnostic{' '}
            <span className="font-medium">{test ?? 'result'}</span> available in
            Pulse. Read the result, then continue with assessment, prescription,
            and disposition.
          </p>
          {error && (
            <p className="mt-2 text-[11px] text-even-pink-700">{error}</p>
          )}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onResume}
          className="rounded-md bg-even-blue px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-even-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Resuming…' : 'Resume encounter'}
        </button>
      </div>
    </div>
  );
}

/** Append a transcript to an existing field. Drops the trailing
 *  newline if the field is empty so the result doesn't lead with one. */
function appendTranscript(current: string, transcript: string): string {
  const t = transcript.trim();
  if (!t) return current;
  if (!current.trim()) return t;
  return `${current.trimEnd()}\n${t}`;
}

function CcChipGrid({
  selected,
  onToggle,
  readOnly,
  ccRankings,
  ccAdditions,
}: {
  selected: string[];
  onToggle: (label: string) => void;
  readOnly?: boolean;
  ccRankings: string[];
  ccAdditions: string[];
}) {
  const sel = new Set(selected);

  // PH.4: re-order each bucket using the patient's Qwen rankings.
  // Chips not in `ccRankings` keep their original relative position
  // after the ranked ones.
  const rankIndex = new Map<string, number>();
  ccRankings.forEach((label, i) => rankIndex.set(label, i));
  const orderInBucket = (a: { label: string }, b: { label: string }) => {
    const ai = rankIndex.has(a.label) ? rankIndex.get(a.label)! : Number.POSITIVE_INFINITY;
    const bi = rankIndex.has(b.label) ? rankIndex.get(b.label)! : Number.POSITIVE_INFINITY;
    return ai - bi;
  };

  const buckets = [
    { name: 'Acute', cat: 'acute' as const },
    { name: 'Follow-up', cat: 'chronic' as const },
    { name: 'Routine', cat: 'routine' as const },
  ];

  // De-dupe additions against the standard catalogue and against each other.
  const standardSet = new Set(CC_CHIPS.map((c) => c.label));
  const seenAdd = new Set<string>();
  const additions = ccAdditions.filter((label) => {
    if (!label || standardSet.has(label)) return false;
    const k = label;
    if (seenAdd.has(k)) return false;
    seenAdd.add(k);
    return true;
  });

  return (
    <div className="space-y-3 rounded-xl border border-even-ink-100 bg-even-ink-50/40 p-3">
      {additions.length > 0 && (
        <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-2">
          <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-800">
            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-violet-500" />
            For this patient
          </p>
          <div className="flex flex-wrap gap-1.5">
            {additions.map((label) => {
              const on = sel.has(label);
              return (
                <button
                  key={`add-${label}`}
                  type="button"
                  disabled={readOnly}
                  onClick={() => onToggle(label)}
                  aria-pressed={on}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed ${
                    on
                      ? 'bg-violet-600 text-white shadow-sm'
                      : 'bg-white text-violet-900 ring-1 ring-violet-300 hover:ring-violet-500'
                  }`}
                >
                  <span
                    aria-hidden
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      on ? 'bg-white' : 'bg-violet-500'
                    }`}
                  />
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {buckets.map((b) => (
        <div key={b.cat}>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-even-ink-500">
            {b.name}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {CC_CHIPS.filter((c) => c.category === b.cat)
              .slice()
              .sort(orderInBucket)
              .map((c) => {
                const on = sel.has(c.label);
                return (
                  <button
                    key={c.label}
                    type="button"
                    disabled={readOnly}
                    onClick={() => onToggle(c.label)}
                    aria-pressed={on}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed ${
                      on
                        ? 'bg-even-blue text-white shadow-sm'
                        : 'bg-white text-even-navy ring-1 ring-even-ink-200 hover:ring-even-blue-300'
                    }`}
                  >
                    {c.label}
                  </button>
                );
              })}
          </div>
        </div>
      ))}
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
