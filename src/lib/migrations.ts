/**
 * Inline migration registry — same pattern as EHRC-Daily-Dash.
 *
 * Why inline (not separate .sql files):
 *   - bundles cleanly into a Vercel serverless function with no extra
 *     filesystem reads
 *   - keeps the migration version + name + SQL in one place that diffs
 *     cleanly in PRs
 *   - the runner at /api/run-migrations applies any unapplied versions
 *     in order, idempotently
 *
 * Rules for new migrations:
 *   1. Append to the end of MIGRATIONS. Never reuse a version number.
 *   2. Prefer IF NOT EXISTS on tables and indexes. Use DO blocks for
 *      enums and other non-idempotent DDL.
 *   3. Each migration runs inside its own transaction. Failures roll back.
 *   4. Statements split on `;` outside dollar-quoted (`$$ … $$`) blocks.
 */

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const MIGRATIONS: Migration[] = [
  {
    version: 0,
    name: 'init_schema_migrations',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    version: 1,
    name: 'opd_demo_schema',
    sql: `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      DO $do$ BEGIN
        CREATE TYPE encounter_status AS ENUM ('active','paused_diagnostics','ready_to_resume','completed');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $do$;

      DO $do$ BEGIN
        CREATE TYPE disposition_kind AS ENUM ('discharge','follow_up','refer','diagnostics','admit','vaccinate');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $do$;

      DO $do$ BEGIN
        CREATE TYPE drug_schedule AS ENUM ('OTC','H','H1','X');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $do$;

      DO $do$ BEGIN
        CREATE TYPE transcription_status AS ENUM ('pending','complete','failed');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $do$;

      CREATE TABLE IF NOT EXISTS patients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mrn TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        age_years INT NOT NULL,
        sex CHAR(1) CHECK (sex IN ('M','F','O')),
        phone_e164 TEXT,
        known_allergies TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS doctors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        mci_registration_number TEXT NOT NULL,
        signature_blob_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS drug_master (
        item_code TEXT PRIMARY KEY,
        brand_name TEXT NOT NULL,
        generic_name TEXT NOT NULL,
        dosage_form TEXT NOT NULL,
        strength TEXT,
        major_grouping TEXT NOT NULL,
        schedule_dc drug_schedule NOT NULL,
        is_high_risk BOOLEAN NOT NULL DEFAULT FALSE,
        lasa_alternates TEXT[],
        default_frequency TEXT,
        default_duration_days INT,
        default_timing TEXT,
        default_instructions TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_drug_brand_trgm ON drug_master USING gin (brand_name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_drug_generic_trgm ON drug_master USING gin (generic_name gin_trgm_ops);

      CREATE TABLE IF NOT EXISTS encounters (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encounter_number TEXT UNIQUE NOT NULL,
        patient_id UUID NOT NULL REFERENCES patients(id),
        doctor_id UUID NOT NULL REFERENCES doctors(id),
        encounter_date DATE NOT NULL DEFAULT CURRENT_DATE,
        status encounter_status NOT NULL DEFAULT 'active',
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        paused_reason TEXT,
        pending_diagnostic_test TEXT,
        chief_complaint_chips TEXT[],
        chief_complaint_text TEXT,
        vitals JSONB,
        exam_findings TEXT,
        assessment_codes TEXT[],
        assessment_text TEXT,
        disposition disposition_kind,
        follow_up_days INT,
        referral_target TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_encounters_doctor_date ON encounters(doctor_id, encounter_date);
      CREATE INDEX IF NOT EXISTS idx_encounters_status ON encounters(status) WHERE status != 'completed';

      CREATE TABLE IF NOT EXISTS encounter_recordings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encounter_id UUID NOT NULL REFERENCES encounters(id),
        recording_session_id UUID NOT NULL,
        snippet_index INT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        duration_seconds INT,
        transcript_status transcription_status NOT NULL DEFAULT 'pending',
        transcript_text TEXT,
        UNIQUE (encounter_id, snippet_index)
      );

      CREATE TABLE IF NOT EXISTS encounter_recording_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recording_id UUID NOT NULL REFERENCES encounter_recordings(id) ON DELETE CASCADE,
        chunk_index INT NOT NULL,
        blob_url TEXT NOT NULL,
        bytes INT NOT NULL,
        UNIQUE (recording_id, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS section_dictations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encounter_id UUID NOT NULL REFERENCES encounters(id),
        section TEXT NOT NULL,
        audio_blob_url TEXT NOT NULL,
        duration_seconds INT NOT NULL,
        transcript_text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS prescriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encounter_id UUID NOT NULL REFERENCES encounters(id) UNIQUE,
        prescription_number TEXT UNIQUE NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pdf_blob_url TEXT,
        lines JSONB NOT NULL,
        patient_sent_at TIMESTAMPTZ,
        pharmacy_sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    version: 2,
    name: 'seed_doctor_v',
    sql: `
      -- Seed V into the doctors table so the magic-link allowlist can move
      -- from env-var to a real DB row. Idempotent — re-running the
      -- migration won't duplicate.
      INSERT INTO doctors (email, name, mci_registration_number)
      VALUES ('vinay.bhardwaj@even.in', 'Dr. Vinay Bhardwaj', 'DEMO-MCI-001')
      ON CONFLICT (email) DO NOTHING;
    `,
  },
  {
    version: 3,
    name: 'seed_patients_and_today_encounters',
    sql: `
      -- 25 patients (Bangalore-area realistic name mix) + today's queue.
      -- Distribution: 8 waiting (no encounter row), 3 paused_diagnostics,
      -- 2 ready_to_resume, 12 completed = 17 encounter rows today.
      --
      -- Patient phone numbers are clearly fake (+91 9876543201..225) so
      -- nothing tries to dial them from the demo.

      INSERT INTO patients (mrn, name, age_years, sex, phone_e164, known_allergies) VALUES
        ('EHRC-2026-001', 'Priya Ramesh',       28, 'F', '+919876543201', NULL),
        ('EHRC-2026-002', 'Rajesh Kumar',       45, 'M', '+919876543202', 'Penicillin'),
        ('EHRC-2026-003', 'Lakshmi Iyer',       62, 'F', '+919876543203', NULL),
        ('EHRC-2026-004', 'Karthik Subramanian',35, 'M', '+919876543204', NULL),
        ('EHRC-2026-005', 'Anita Sharma',       38, 'F', '+919876543205', 'Sulfa drugs'),
        ('EHRC-2026-006', 'Vikram Singh',       52, 'M', '+919876543206', NULL),
        ('EHRC-2026-007', 'Meera Pillai',       29, 'F', '+919876543207', NULL),
        ('EHRC-2026-008', 'Suresh Reddy',       58, 'M', '+919876543208', 'Aspirin'),
        ('EHRC-2026-009', 'Deepika Nair',       31, 'F', '+919876543209', NULL),
        ('EHRC-2026-010', 'Arjun Murthy',       42, 'M', '+919876543210', NULL),
        ('EHRC-2026-011', 'Sunita Krishnan',    49, 'F', '+919876543211', NULL),
        ('EHRC-2026-012', 'Mohan Rao',          66, 'M', '+919876543212', 'Iodine contrast'),
        ('EHRC-2026-013', 'Kavya Bhat',         24, 'F', '+919876543213', NULL),
        ('EHRC-2026-014', 'Rohan Mehta',        37, 'M', '+919876543214', NULL),
        ('EHRC-2026-015', 'Geetha Prasad',      55, 'F', '+919876543215', NULL),
        ('EHRC-2026-016', 'Naveen Gowda',       33, 'M', '+919876543216', NULL),
        ('EHRC-2026-017', 'Aishwarya Rao',      27, 'F', '+919876543217', NULL),
        ('EHRC-2026-018', 'Prakash Hegde',      61, 'M', '+919876543218', NULL),
        ('EHRC-2026-019', 'Divya Joshi',        40, 'F', '+919876543219', NULL),
        ('EHRC-2026-020', 'Sandeep Patel',      44, 'M', '+919876543220', NULL),
        ('EHRC-2026-021', 'Shobha Kumari',      34, 'F', '+919876543221', NULL),
        ('EHRC-2026-022', 'Ravi Shankar',       53, 'M', '+919876543222', NULL),
        ('EHRC-2026-023', 'Pooja Shenoy',       32, 'F', '+919876543223', NULL),
        ('EHRC-2026-024', 'Manoj Verma',        47, 'M', '+919876543224', NULL),
        ('EHRC-2026-025', 'Asha Pai',           26, 'F', '+919876543225', NULL)
      ON CONFLICT (mrn) DO NOTHING;

      -- 12 completed today, 3 paused for diagnostics, 2 ready_to_resume.
      -- 8 patients (EHRC-2026-018..025) are intentionally left without
      -- encounters so they show as "Waiting" in the queue.

      INSERT INTO encounters (
        encounter_number, patient_id, doctor_id, encounter_date,
        status, started_at, completed_at, paused_reason, pending_diagnostic_test,
        chief_complaint_text, exam_findings, assessment_text,
        disposition, follow_up_days
      )
      SELECT
        v.enc_no,
        p.id,
        d.id,
        CURRENT_DATE,
        v.status::encounter_status,
        v.started_at,
        v.completed_at,
        v.paused_reason,
        v.pending_diagnostic_test,
        v.cc,
        v.exam,
        v.assessment,
        NULLIF(v.disposition, '')::disposition_kind,
        v.follow_up_days
      FROM (VALUES
        -- COMPLETED (12)
        ('ENC-20260518-001', 'EHRC-2026-001', 'completed'::text, NOW() - INTERVAL '3h 30m', NOW() - INTERVAL '3h 18m', NULL::text, NULL::text, 'Sore throat 3 days, low-grade fever',                'Mildly inflamed pharynx, no exudate, afebrile on exam',           'Acute pharyngitis, likely viral',                          'discharge'::text, NULL::int),
        ('ENC-20260518-002', 'EHRC-2026-002', 'completed', NOW() - INTERVAL '3h 15m', NOW() - INTERVAL '2h 50m', NULL, NULL, 'Hypertension follow-up, BP 148/92 home readings',           'BP 144/88 in clinic, HR 76 regular, no edema',                    'Essential HTN — sub-optimal control on current regimen',   'follow_up',     14),
        ('ENC-20260518-003', 'EHRC-2026-003', 'completed', NOW() - INTERVAL '2h 55m', NOW() - INTERVAL '2h 38m', NULL, NULL, 'Knee pain x 2 weeks, worse on stairs',                       'Crepitus right knee, no effusion, ROM 0-110 painful at extreme',  'Right knee osteoarthritis',                                'refer',         NULL),
        ('ENC-20260518-004', 'EHRC-2026-004', 'completed', NOW() - INTERVAL '2h 40m', NOW() - INTERVAL '2h 28m', NULL, NULL, 'Annual check-up, no complaints',                             'Unremarkable. BP 122/78, BMI 24.6.',                              'Healthy adult, due for routine bloods',                    'discharge',     NULL),
        ('ENC-20260518-005', 'EHRC-2026-005', 'completed', NOW() - INTERVAL '2h 25m', NOW() - INTERVAL '2h 10m', NULL, NULL, 'Migraine recurrence, 2nd episode this month',                'Neuro grossly intact, no focal deficit, no nuchal rigidity',      'Migraine without aura',                                    'follow_up',     30),
        ('ENC-20260518-006', 'EHRC-2026-006', 'completed', NOW() - INTERVAL '2h 10m', NOW() - INTERVAL '1h 55m', NULL, NULL, 'Type 2 DM review, fasting BSL 162',                          'Feet exam normal, no ulcers, dorsalis pedis pulses palpable',     'T2DM — fair control, HbA1c due',                           'follow_up',     30),
        ('ENC-20260518-007', 'EHRC-2026-007', 'completed', NOW() - INTERVAL '1h 55m', NOW() - INTERVAL '1h 40m', NULL, NULL, 'Acid reflux, worse at night',                                'Soft non-tender abdomen, no organomegaly',                        'GERD',                                                     'discharge',     NULL),
        ('ENC-20260518-008', 'EHRC-2026-008', 'completed', NOW() - INTERVAL '1h 40m', NOW() - INTERVAL '1h 22m', NULL, NULL, 'Chest discomfort on exertion, x 5 days',                     'BP 152/90, HR 88, S1S2 normal, no murmur, lungs clear',           'Suspected stable angina — for cardiology referral',        'refer',         NULL),
        ('ENC-20260518-009', 'EHRC-2026-009', 'completed', NOW() - INTERVAL '1h 25m', NOW() - INTERVAL '1h 12m', NULL, NULL, 'UTI symptoms x 2 days',                                       'No costovertebral angle tenderness, suprapubic mild',             'Uncomplicated lower UTI',                                  'discharge',     NULL),
        ('ENC-20260518-010', 'EHRC-2026-010', 'completed', NOW() - INTERVAL '1h 10m', NOW() - INTERVAL '58m',    NULL, NULL, 'Back pain after lifting, x 4 days',                          'Para-spinal muscle tenderness L4-L5, SLR negative bilaterally',   'Mechanical low back pain',                                 'discharge',     NULL),
        ('ENC-20260518-011', 'EHRC-2026-011', 'completed', NOW() - INTERVAL '55m',    NOW() - INTERVAL '42m',    NULL, NULL, 'Allergic rhinitis flare, sneezing + post-nasal drip',         'Nasal mucosa pale and boggy, no sinus tenderness',                'Allergic rhinitis',                                        'discharge',     NULL),
        ('ENC-20260518-012', 'EHRC-2026-012', 'completed', NOW() - INTERVAL '40m',    NOW() - INTERVAL '28m',    NULL, NULL, 'Routine BP + diabetes review',                                'BP 138/82, weight stable, no edema',                              'HTN + T2DM, both well-controlled',                         'follow_up',     90),

        -- PAUSED for diagnostics (3) — disposition empty, completed_at NULL
        ('ENC-20260518-013', 'EHRC-2026-013', 'paused_diagnostics'::text, NOW() - INTERVAL '35m', NULL, 'diagnostics'::text, 'Chest x-ray'::text,         'Cough + low-grade fever x 6 days',                'Right lower zone crackles, RR 22, SpO2 97%',                'Suspected pneumonia — awaiting CXR',                       ''::text, NULL::int),
        ('ENC-20260518-014', 'EHRC-2026-014', 'paused_diagnostics',       NOW() - INTERVAL '28m', NULL, 'diagnostics',       'ECG',                       'Palpitations + occasional dizziness, x 2 weeks',  'BP 130/82, HR 92 irregular, no S3/S4',                       'R/o arrhythmia — awaiting ECG',                            '',       NULL),
        ('ENC-20260518-015', 'EHRC-2026-015', 'paused_diagnostics',       NOW() - INTERVAL '20m', NULL, 'diagnostics',       'USG abdomen',               'RUQ pain + nausea, fatty food intolerance, x 1mo','Mild RUQ tenderness, no rebound, Murphy negative',           'R/o cholelithiasis — awaiting USG',                        '',       NULL),

        -- READY TO RESUME (2) — same shape as paused but the test is back
        ('ENC-20260518-016', 'EHRC-2026-016', 'ready_to_resume'::text, NOW() - INTERVAL '1h 5m', NULL, 'diagnostics'::text, 'CBC + CRP'::text,   'Fever x 4 days, no localising symptoms', 'Looks well, no rash, no neck stiffness, BP 118/74',  'Pyrexia of unknown origin — workup pending', '', NULL),
        ('ENC-20260518-017', 'EHRC-2026-017', 'ready_to_resume',       NOW() - INTERVAL '50m',   NULL, 'diagnostics',       'Urine routine',     'Burning micturition x 3 days',           'Suprapubic tenderness, no flank tenderness',          'R/o UTI — urine sent',                        '', NULL)
      ) v(enc_no, mrn, status, started_at, completed_at, paused_reason, pending_diagnostic_test, cc, exam, assessment, disposition, follow_up_days)
      JOIN patients p ON p.mrn = v.mrn
      JOIN doctors d ON d.email = 'vinay.bhardwaj@even.in'
      ON CONFLICT (encounter_number) DO NOTHING;
    `,
  },
  {
    version: 4,
    name: 'relax_section_dictation_blob_url',
    sql: `
      -- Sprint 3 lays the section-dictation scaffold (UI + API + DB row).
      -- Real audio capture + Blob upload ship in Sprint 5. Until then a
      -- dictation row can exist with NULL audio_blob_url meaning
      -- "doctor intended to dictate here, no audio yet."
      ALTER TABLE section_dictations
        ALTER COLUMN audio_blob_url DROP NOT NULL;
    `,
  },
  {
    version: 5,
    name: 'patient_summaries',
    sql: `
      -- PH.1: cached Qwen output per patient. One row per patient, one
      -- JSONB blob holding the whole summary. Recomputed post-encounter-
      -- submit + on-demand from /patients/[id].
      CREATE TABLE IF NOT EXISTS patient_summaries (
        patient_id UUID PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
        summary JSONB NOT NULL,
        source_encounter_count INT NOT NULL,
        source_window_start DATE NOT NULL,
        source_window_end DATE NOT NULL,
        qwen_model TEXT NOT NULL,
        qwen_latency_ms INT,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'fresh',
        fail_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_patient_summaries_status
        ON patient_summaries(status) WHERE status != 'fresh';
    `,
  },
  {
    version: 6,
    name: 'qwen_call_audit',
    sql: `
      -- PH.1: per-call audit. Hashes only — no raw PHI in logs (Round 5
      -- decision). Replay debug works by re-running with the same
      -- input window.
      CREATE TABLE IF NOT EXISTS qwen_call_audit (
        id BIGSERIAL PRIMARY KEY,
        patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        doctor_id UUID REFERENCES doctors(id),
        prompt_hash TEXT NOT NULL,
        output_hash TEXT NOT NULL,
        qwen_model TEXT NOT NULL,
        qwen_latency_ms INT,
        result TEXT NOT NULL,
        called_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_qwen_call_audit_patient
        ON qwen_call_audit(patient_id, called_at DESC);
    `,
  },
  {
    version: 7,
    name: 'encounters_disposition_label_override',
    sql: `
      -- PH.4: patient-specific disposition labels.
      -- When the doctor picks one of Qwen's net-new disposition_additions
      -- (e.g. "Refer to Dr. Iyer · Cardiology"), the underlying
      -- disposition enum still resolves to one of the 6 standard values
      -- (typically 'refer') but the human-readable label override lets
      -- the PDF + dashboard surface what the doctor actually picked.
      ALTER TABLE encounters
        ADD COLUMN IF NOT EXISTS disposition_label_override TEXT;
    `,
  },
  {
    version: 8,
    name: 'doctor_overrides',
    sql: `
      -- PH.5: per-patient corrections the doctor makes to the AI summary.
      -- These get folded back into the Qwen user-message on the next
      -- recompute so the model honours "this is resolved" / "rename
      -- this problem" / "dismiss this allergy" etc.
      --
      -- target_kind enumerates what was overridden; payload carries the
      -- override-specific fields (jsonb) — keeps the schema small while
      -- still being queryable per kind.
      CREATE TABLE IF NOT EXISTS doctor_overrides (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        doctor_id UUID REFERENCES doctors(id),
        target_kind TEXT NOT NULL,        -- 'problem' | 'allergy' | 'cc_chip'
        target_key TEXT NOT NULL,         -- label/text identifying the target
        action TEXT NOT NULL,             -- 'edit' | 'dismiss' | 'add'
        payload JSONB,                    -- { label?, status?, note?, ... }
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_doctor_overrides_patient
        ON doctor_overrides(patient_id, target_kind);
    `,
  },
  {
    version: 9,
    name: 'users_role_column',
    sql: `
      -- v2.0.0: the doctors table now holds all staff roles. Name kept
      -- as 'doctors' for pragmatic reasons (avoids touching every
      -- existing query); semantically it's the users table.
      ALTER TABLE doctors
        ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'doctor'
        CHECK (role IN ('doctor','nurse','cce','lab_tech','admin'));
      CREATE INDEX IF NOT EXISTS idx_doctors_role ON doctors(role);
    `,
  },
  {
    version: 10,
    name: 'encounter_status_extended',
    sql: `
      -- v2.0.0: add three pre-doctor states for the CCE / Triage flow.
      -- Order matters semantically: registered → at_triage → waiting_for_doctor → active.
      ALTER TYPE encounter_status ADD VALUE IF NOT EXISTS 'registered';
      ALTER TYPE encounter_status ADD VALUE IF NOT EXISTS 'at_triage';
      ALTER TYPE encounter_status ADD VALUE IF NOT EXISTS 'waiting_for_doctor';
    `,
  },
  {
    version: 11,
    name: 'opd_rooms',
    sql: `
      -- v2.0.0: physical OPD rooms with a default doctor. CCE assigns
      -- patients to rooms; the room's default doctor owns the queue.
      -- Admin can swap default_doctor_id when shifts change.
      CREATE TABLE IF NOT EXISTS opd_rooms (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT UNIQUE NOT NULL,
        floor TEXT,
        default_doctor_id UUID REFERENCES doctors(id),
        specialty TEXT,                  -- 'Neurology', 'Internal Medicine', ...
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_opd_rooms_active ON opd_rooms(active);
    `,
  },
  {
    version: 12,
    name: 'encounters_v2_columns',
    sql: `
      -- v2.0.0: encounter gains room assignment, CCE-captured visit
      -- reason, a day-of token (defaults to MRN per Round 2 decision),
      -- and triage attribution. doctor_id stays as the encounter's
      -- primary doctor (resolved from room.default_doctor at registration).
      ALTER TABLE encounters
        ADD COLUMN IF NOT EXISTS room_id UUID REFERENCES opd_rooms(id),
        ADD COLUMN IF NOT EXISTS intake_visit_reason TEXT,
        ADD COLUMN IF NOT EXISTS token_number TEXT,
        ADD COLUMN IF NOT EXISTS triage_nurse_id UUID REFERENCES doctors(id),
        ADD COLUMN IF NOT EXISTS triage_completed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS registered_by_cce_id UUID REFERENCES doctors(id),
        ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_encounters_room_status
        ON encounters(room_id, status) WHERE status != 'completed';
    `,
  },
  {
    version: 13,
    name: 'lab_orders_and_results',
    sql: `
      -- v2.1: free-text orders, Qwen-normalized canonical_key. No lab
      -- catalog table per Round 4 decision. Trending works on
      -- lab_results.canonical_key + patient_id.
      CREATE TABLE IF NOT EXISTS lab_orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encounter_id UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
        patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        ordering_doctor_id UUID NOT NULL REFERENCES doctors(id),
        raw_text TEXT NOT NULL,
        canonical_key TEXT,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','in_progress','resulted','cancelled')),
        ordered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resulted_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_lab_orders_patient ON lab_orders(patient_id, ordered_at DESC);
      CREATE INDEX IF NOT EXISTS idx_lab_orders_status ON lab_orders(status) WHERE status != 'resulted';

      CREATE TABLE IF NOT EXISTS lab_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lab_order_id UUID REFERENCES lab_orders(id) ON DELETE SET NULL,
        patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        canonical_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        value_numeric NUMERIC,
        value_text TEXT,
        unit TEXT,
        reference_range TEXT,
        is_critical BOOLEAN NOT NULL DEFAULT FALSE,
        source_pdf_url TEXT,
        entered_by UUID REFERENCES doctors(id),
        entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_lab_results_patient_key
        ON lab_results(patient_id, canonical_key, entered_at DESC);
      CREATE INDEX IF NOT EXISTS idx_lab_results_critical
        ON lab_results(patient_id, is_critical) WHERE is_critical = TRUE;
    `,
  },
  {
    version: 14,
    name: 'encounter_handoff_columns',
    sql: `
      -- v2.3: cross-doctor handoff notes. Set on encounter completion;
      -- shown as a pinned banner on the patient's next encounter open
      -- across any doctor; auto-dismisses when next doctor ack'd.
      ALTER TABLE encounters
        ADD COLUMN IF NOT EXISTS handoff_note TEXT,
        ADD COLUMN IF NOT EXISTS handoff_ack_by UUID REFERENCES doctors(id),
        ADD COLUMN IF NOT EXISTS handoff_ack_at TIMESTAMPTZ;
    `,
  },
  {
    version: 15,
    name: 'encounter_ddi_findings',
    sql: `
      -- v2.2: DDI scan results persist on the encounter for audit + UI rehydration.
      -- Shape: [{ severity, pair: [a,b], rationale, scanned_at }, ...]
      ALTER TABLE encounters
        ADD COLUMN IF NOT EXISTS ddi_findings JSONB;
    `,
  },
  {
    version: 16,
    name: 'invite_tokens',
    sql: `
      -- v2.0.1: admin-generated invite tokens for the magic-link signup flow.
      -- An admin pre-stages a user's email + role at /admin/users; the system
      -- emails them a link to /auth/signup?invite=<token>. Accepting the link
      -- INSERTs a row into doctors with the staged role + logs accepted_at.
      --
      -- token is a 32-byte hex string. UNIQUE so URLs can't be guessed.
      -- expires_at defaults to NOW() + 7 days; accept_token() refuses
      -- expired or already-accepted invites.
      CREATE TABLE IF NOT EXISTS invite_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token TEXT UNIQUE NOT NULL,
        email TEXT NOT NULL,
        name TEXT,
        role TEXT NOT NULL
          CHECK (role IN ('doctor','nurse','cce','lab_tech','admin')),
        created_by UUID REFERENCES doctors(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        accepted_at TIMESTAMPTZ,
        accepted_user_id UUID REFERENCES doctors(id)
      );
      CREATE INDEX IF NOT EXISTS idx_invite_tokens_email ON invite_tokens(lower(email));
      CREATE INDEX IF NOT EXISTS idx_invite_tokens_pending
        ON invite_tokens(expires_at) WHERE accepted_at IS NULL;
    `,
  },
  {
    version: 17,
    name: 'users_deactivated_at',
    sql: `
      -- v2.0.2: admin can deactivate users (e.g. resigned staff) without
      -- losing their historical attribution on encounters / overrides /
      -- audit rows. deactivated_at non-NULL means the user can no longer
      -- sign in.
      ALTER TABLE doctors
        ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_doctors_active
        ON doctors(role) WHERE deactivated_at IS NULL;
    `,
  },
  {
    version: 18,
    name: 'seed_admin_user',
    sql: `
      -- v2.0.2: ensure at least one admin user exists for /admin gate.
      -- V (vinay.bhardwaj@even.in) keeps role='doctor' for clinical
      -- workflow; the admin row is a separate identity.
      INSERT INTO doctors (email, name, mci_registration_number, role)
      VALUES ('admin@even.in', 'Admin', 'EH-EMP-ADMIN-001', 'admin')
      ON CONFLICT (email) DO UPDATE SET role = 'admin';
    `,
  },
  {
    version: 19,
    name: 'lab_orders_v21_extensions',
    sql: `
      -- v2.1.1: Lab Workstation extensions on top of v13's lab_orders/lab_results.
      --
      -- Three things change:
      --   1. CCE can pre-stage labs before the doctor sees the patient
      --      (Round-extra decision: "Doctor + CCE"). pre_staged_by_cce_id
      --      records who, and a new 'pre_staged' status keeps these out of
      --      the lab tech's inbox until the doctor confirms ("Send to lab"
      --      flips pre_staged → pending and atomically pauses the encounter).
      --   2. ordering_doctor_id becomes nullable because a pre_staged
      --      order may not have a confirmed doctor yet (the row gets
      --      stamped with the doctor's id on confirm).
      --   3. Qwen vision auto-post flow needs to remember extraction
      --      confidence + raw response so the tech UI can show why we
      --      auto-posted (or didn't) and the audit trail keeps the raw
      --      JSON for later debugging.

      -- Make ordering_doctor_id nullable (pre_staged orders haven't been
      -- confirmed by a doctor yet).
      ALTER TABLE lab_orders
        ALTER COLUMN ordering_doctor_id DROP NOT NULL;

      -- Track which CCE pre-staged the order, if any.
      ALTER TABLE lab_orders
        ADD COLUMN IF NOT EXISTS pre_staged_by_cce_id UUID
          REFERENCES doctors(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS pre_staged_at TIMESTAMPTZ;

      -- Per-order PDF + Qwen extraction metadata. Lab results live in
      -- the lab_results table; this is order-level provenance.
      ALTER TABLE lab_orders
        ADD COLUMN IF NOT EXISTS source_pdf_url TEXT,
        ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS extraction_confidence NUMERIC,
        ADD COLUMN IF NOT EXISTS extraction_raw JSONB,
        ADD COLUMN IF NOT EXISTS extraction_lab_tech_id UUID
          REFERENCES doctors(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS auto_posted BOOLEAN NOT NULL DEFAULT FALSE;

      -- Extend the status CHECK to allow 'pre_staged'.
      DO $$
      BEGIN
        ALTER TABLE lab_orders DROP CONSTRAINT IF EXISTS lab_orders_status_check;
      EXCEPTION WHEN undefined_object THEN NULL;
      END $$;
      ALTER TABLE lab_orders
        ADD CONSTRAINT lab_orders_status_check
        CHECK (status IN ('pre_staged','pending','in_progress','awaiting_confirmation','resulted','cancelled'));

      -- Index for the lab tech's inbox: anything not pre_staged and not
      -- resulted, ordered FIFO.
      CREATE INDEX IF NOT EXISTS idx_lab_orders_inbox
        ON lab_orders(status, ordered_at)
        WHERE status IN ('pending','in_progress','awaiting_confirmation');

      -- Per-result confidence (from Qwen). Critical for the auto-post
      -- threshold (≥0.9 → auto-post; else edit grid).
      ALTER TABLE lab_results
        ADD COLUMN IF NOT EXISTS confidence_score NUMERIC,
        ADD COLUMN IF NOT EXISTS abnormal_flag TEXT
          CHECK (abnormal_flag IN ('low','high','critical_low','critical_high','normal','unknown'));
    `,
  },
  {
    version: 20,
    name: 'lab_orders_v212_claim_fields',
    sql: `
      -- v2.1.2: soft-claim fields for the /lab workstation.
      --
      -- Why "soft": status (pending → in_progress) is already the
      -- source of truth for actionability. claimed_by_lab_tech_id +
      -- claimed_at give the OTHER techs a "Claimed by Anjali · 2m ago"
      -- banner so they don't double-handle, but a teammate CAN still
      -- open the row and take over if Anjali walks away.
      --
      -- Auto-release isn't in this migration — that's a v2.1.x polish
      -- decision (locked as deferred). For now release is manual or
      -- happens implicitly on status flips that move the row past
      -- in_progress.
      ALTER TABLE lab_orders
        ADD COLUMN IF NOT EXISTS claimed_by_lab_tech_id UUID
          REFERENCES doctors(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

      -- Partial index for "currently claimed" lookups — useful when the
      -- inbox splits "in progress (mine)" from "in progress (others)".
      CREATE INDEX IF NOT EXISTS idx_lab_orders_claimed
        ON lab_orders(claimed_by_lab_tech_id)
        WHERE claimed_by_lab_tech_id IS NOT NULL;
    `,
  },
  {
    version: 21,
    name: 'encounters_ddx_findings',
    sql: `
      -- v2.2.2 — Auto-DDx-on-Submit (PRD Round 5 #12). Mirrors the
      -- v15 ddi_findings column pattern.
      --
      -- Shape:
      --   {
      --     status: 'ok' | 'failed',
      --     findings: [{
      --       condition: string,
      --       likelihood: 'high' | 'medium' | 'low',
      --       rationale: string,
      --       source_encounter_ids: uuid[],   -- past encounters that informed
      --     }],
      --     scanned_at, latency_ms, error?
      --   }
      --
      -- Stays JSONB so we can iterate on shape without migrations. The
      -- DDx is computed once on Submit click and cached so the
      -- confirmation modal renders instantly on subsequent opens.
      ALTER TABLE encounters
        ADD COLUMN IF NOT EXISTS ddx_findings JSONB;
    `,
  },
  {
    version: 22,
    name: 'voice_queries',
    sql: `
      -- v2.2.3 — Push-to-talk voice query (PRD Round 5 #11). Stores
      -- transcript + Qwen answer + provenance. NO audio_blob_url —
      -- per lock #14 we keep transcript + answer only to save storage.
      CREATE TABLE IF NOT EXISTS voice_queries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encounter_id UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
        doctor_id UUID NOT NULL REFERENCES doctors(id),
        question_transcript TEXT NOT NULL,
        answer_text TEXT NOT NULL,
        sources_json JSONB,
        latency_ms INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_voice_queries_encounter
        ON voice_queries(encounter_id, created_at DESC);
    `,
  },
  {
    version: 23,
    name: 'encounters_multi_doctor_handoff',
    sql: `
      -- v2.3 — Multi-doctor handoff (pull model + per-section attribution).
      --
      -- Two new JSONB columns on encounters; no new tables (the data is
      -- cheap to read alongside the encounter row + the shapes can
      -- evolve without migrations).
      --
      -- contributors_json shape:
      --   [
      --     { doctor_id: <uuid>, joined_at: <iso>, via: 'initial' | 'handoff_claim' }
      --   ]
      --   Append-only on each ownership change. First entry is always
      --   the initial doctor; each subsequent claim appends.
      --
      -- section_editors shape:
      --   {
      --     <section_name>: { doctor_id: <uuid>, edited_at: <iso> }
      --   }
      --   Updated by PATCH /api/encounters/[id] for each section
      --   touched in that write. Per-section last-edited-by chip on the
      --   encounter screen reads this map.
      --
      --   Sections tracked:
      --     'chief_complaint' | 'exam_findings' | 'vitals' |
      --     'assessment'      | 'prescription'   | 'disposition'
      ALTER TABLE encounters
        ADD COLUMN IF NOT EXISTS contributors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS section_editors JSONB NOT NULL DEFAULT '{}'::jsonb;

      -- Backfill existing encounters with their initial doctor as the
      -- only contributor. Use the existing doctor_id + started_at as a
      -- reasonable proxy for joined_at.
      UPDATE encounters
      SET contributors_json = jsonb_build_array(
        jsonb_build_object(
          'doctor_id', doctor_id,
          'joined_at', COALESCE(started_at, NOW()),
          'via', 'initial'
        )
      )
      WHERE contributors_json = '[]'::jsonb;
    `,
  },
  {
    version: 24,
    name: 'lab_result_annotations',
    sql: `
      -- Polish #4 — Clinician annotations on posted lab results.
      --
      -- Append-only. The original lab_results row is NEVER edited
      -- (PRD lock: 'add an annotation, never edit the original').
      -- Annotations render inline beneath the value and stay in the
      -- audit trail forever.
      CREATE TABLE IF NOT EXISTS lab_result_annotations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lab_result_id UUID NOT NULL REFERENCES lab_results(id) ON DELETE CASCADE,
        doctor_id UUID NOT NULL REFERENCES doctors(id),
        note TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_lab_result_annotations_result
        ON lab_result_annotations(lab_result_id, created_at DESC);
    `,
  },
  {
    version: 25,
    name: 'v3_diagnostic_foundation',
    sql: `
      -- v3.0 — diagnostic-ordering rebuild FOUNDATION (additive only).
      --
      -- This migration adds every NEW v3 table + the AI suggestion cache
      -- columns on encounters. It does NOT touch lab_orders or any other
      -- v2 table. The v2 lab pipeline keeps working unchanged.
      --
      -- Tables created:
      --   - diagnostic_catalog          (canonical EHRC test catalog,
      --                                  seeded in v3.1 from xlsx)
      --   - diagnostic_bundles          (super-admin curated, seeded v3.4)
      --   - diagnostic_bundle_items     (junction)
      --   - diagnostic_orders           (unified parent — labs + imaging
      --                                  + cardiology + procedure)
      --
      -- Columns added on encounters:
      --   - ai_suggested_orders               JSONB (v3.5a cache)
      --   - ai_suggested_orders_generated_at  TIMESTAMPTZ
      --   - ai_suggested_orders_context_hash  TEXT
      --
      -- The destructive cutover (DROP lab_orders TABLE, replace with
      -- VIEW + INSTEAD OF triggers backfilling into diagnostic_orders
      -- with service_code FK to catalog) is its own migration in
      -- v3.0b — runs AFTER v3.1 (catalog seed) + v3.2 (new ordering UI)
      -- are real-data-tested.

      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      -- 1. diagnostic_catalog ---------------------------------------
      CREATE TABLE IF NOT EXISTS diagnostic_catalog (
        service_code         TEXT PRIMARY KEY,
        display_name         TEXT NOT NULL,
        department           TEXT NOT NULL,
        sub_department       TEXT NOT NULL,
        service_type         TEXT NOT NULL,
        modality             TEXT NOT NULL
          CHECK (modality IN ('lab', 'imaging', 'cardiology', 'procedure')),
        patient_types        TEXT[] NOT NULL DEFAULT '{}',
        is_active            BOOLEAN NOT NULL DEFAULT true,
        is_outsourced        BOOLEAN NOT NULL DEFAULT false,
        schedulable          BOOLEAN NOT NULL DEFAULT false,
        multiple_sittings    BOOLEAN NOT NULL DEFAULT false,
        description          TEXT,
        patient_instructions TEXT,
        synonyms             TEXT[] NOT NULL DEFAULT '{}',
        standard_codes       JSONB NOT NULL DEFAULT '{}'::jsonb,
        tags                 TEXT[] NOT NULL DEFAULT '{}',
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Generated tsvector column for FTS (idempotent add)
      -- Note: Postgres treats to_tsvector(...) AND the 'english'::regconfig
      -- cast as STABLE (not IMMUTABLE) because the registered TS config
      -- could in theory change. GENERATED columns demand IMMUTABLE. The
      -- bulletproof pattern is an IMMUTABLE wrapper function: Postgres
      -- trusts the declared marker at face value.
      CREATE OR REPLACE FUNCTION diagnostic_catalog_search_tsv_immut(
        p_display_name   text,
        p_synonyms       text[],
        p_sub_department text,
        p_description    text
      ) RETURNS tsvector
      LANGUAGE sql
      IMMUTABLE
      PARALLEL SAFE
      AS $fn$
        SELECT
          setweight(to_tsvector('english'::regconfig, coalesce(p_display_name, '')), 'A') ||
          setweight(to_tsvector('english'::regconfig, coalesce(array_to_string(p_synonyms, ' '), '')), 'B') ||
          setweight(to_tsvector('english'::regconfig, coalesce(p_sub_department, '')), 'C') ||
          setweight(to_tsvector('english'::regconfig, coalesce(p_description, '')), 'D');
      $fn$;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'diagnostic_catalog'
            AND column_name = 'search_tsv'
        ) THEN
          ALTER TABLE diagnostic_catalog
            ADD COLUMN search_tsv tsvector
            GENERATED ALWAYS AS (
              diagnostic_catalog_search_tsv_immut(
                display_name, synonyms, sub_department, description
              )
            ) STORED;
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS diagnostic_catalog_tsv_idx
        ON diagnostic_catalog USING GIN (search_tsv);

      -- pg_trgm index expression must be IMMUTABLE; array_to_string is STABLE
      -- in Postgres, so we wrap the concat in an IMMUTABLE function. Queries
      -- must use the SAME function expression to hit this index.
      CREATE OR REPLACE FUNCTION diagnostic_catalog_search_text_immut(
        p_display_name text,
        p_synonyms     text[]
      ) RETURNS text
      LANGUAGE sql
      IMMUTABLE
      PARALLEL SAFE
      AS $fn$
        SELECT coalesce(p_display_name, '') || ' ' ||
               coalesce(array_to_string(p_synonyms, ' '), '');
      $fn$;

      CREATE INDEX IF NOT EXISTS diagnostic_catalog_trgm_idx
        ON diagnostic_catalog
        USING GIN (
          diagnostic_catalog_search_text_immut(display_name, synonyms) gin_trgm_ops
        );

      CREATE INDEX IF NOT EXISTS diagnostic_catalog_modality_active_idx
        ON diagnostic_catalog (modality, is_active);

      CREATE INDEX IF NOT EXISTS diagnostic_catalog_dept_idx
        ON diagnostic_catalog (department, sub_department) WHERE is_active = true;

      -- 2. bundles --------------------------------------------------
      CREATE TABLE IF NOT EXISTS diagnostic_bundles (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name                 TEXT NOT NULL UNIQUE,
        description          TEXT,
        specialty_tag        TEXT,
        is_active            BOOLEAN NOT NULL DEFAULT true,
        created_by_doctor_id UUID REFERENCES doctors(id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS diagnostic_bundle_items (
        bundle_id    UUID NOT NULL REFERENCES diagnostic_bundles(id) ON DELETE CASCADE,
        service_code TEXT NOT NULL REFERENCES diagnostic_catalog(service_code),
        order_n      INTEGER NOT NULL,
        is_optional  BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (bundle_id, service_code)
      );

      CREATE INDEX IF NOT EXISTS diagnostic_bundle_items_bundle_idx
        ON diagnostic_bundle_items (bundle_id, order_n);

      -- 3. diagnostic_orders (unified parent) ----------------------
      CREATE TABLE IF NOT EXISTS diagnostic_orders (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encounter_id           UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
        service_code           TEXT NOT NULL REFERENCES diagnostic_catalog(service_code),
        modality               TEXT NOT NULL
          CHECK (modality IN ('lab', 'imaging', 'cardiology', 'procedure')),

        -- lifecycle: lab states preserved (pre_staged | ordered | in_progress |
        -- awaiting_confirmation | posted | cancelled), imaging (ordered |
        -- dispatched | completed), procedure (ordered | in_progress | completed)
        status                 TEXT NOT NULL,

        ordered_by_doctor_id   UUID REFERENCES doctors(id),
        ordered_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ordering_actor         TEXT NOT NULL DEFAULT 'doctor'
          CHECK (ordering_actor IN ('cce_prestage', 'doctor', 'auto_bundle', 'ai_suggestion_accepted')),
        source_bundle_id       UUID REFERENCES diagnostic_bundles(id),

        -- lab-specific (mirror v2 lab_orders shape — v3.0b backfill target)
        claimed_by_lab_tech_id UUID REFERENCES doctors(id),
        claimed_at             TIMESTAMPTZ,
        result_pdf_url         TEXT,
        extraction_raw         JSONB,
        extraction_confidence  NUMERIC,
        posted_at              TIMESTAMPTZ,

        -- imaging-specific (v3.6)
        laterality             TEXT,
        body_area              TEXT,
        clinical_indication    TEXT,
        referral_pdf_url       TEXT,

        -- procedure-specific (v3.6)
        operator_doctor_id     UUID REFERENCES doctors(id),
        procedure_note         TEXT,

        -- audit
        cancelled_at           TIMESTAMPTZ,
        cancelled_by_doctor_id UUID REFERENCES doctors(id),
        cancel_reason          TEXT,

        modality_meta          JSONB NOT NULL DEFAULT '{}'::jsonb,

        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS diagnostic_orders_encounter_idx
        ON diagnostic_orders (encounter_id);

      CREATE INDEX IF NOT EXISTS diagnostic_orders_modality_status_idx
        ON diagnostic_orders (modality, status);

      CREATE INDEX IF NOT EXISTS diagnostic_orders_lab_inbox_idx
        ON diagnostic_orders (status, claimed_by_lab_tech_id)
        WHERE modality = 'lab';

      -- 4. encounters.ai_suggested_orders cache (v3.5a consumer) ---
      ALTER TABLE encounters
        ADD COLUMN IF NOT EXISTS ai_suggested_orders JSONB;
      ALTER TABLE encounters
        ADD COLUMN IF NOT EXISTS ai_suggested_orders_generated_at TIMESTAMPTZ;
      ALTER TABLE encounters
        ADD COLUMN IF NOT EXISTS ai_suggested_orders_context_hash TEXT;
    `,
  },
];

/**
 * Split SQL string into statements, respecting dollar-quoted blocks.
 *
 * Naive split on `;` breaks DO $$...$$ blocks because they often contain
 * semicolons inside. We track when we're inside a $tag$...$tag$ region
 * and only split outside.
 *
 * This is the same splitter pattern EHRC's EPI.v3.0a sprint had to add
 * after the naive splitter mangled their DO blocks.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  let dollarTag: string | null = null;
  let inLineComment = false;

  while (i < sql.length) {
    const ch = sql[i];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      current += ch;
      i++;
      continue;
    }

    if (!dollarTag && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      current += ch;
      i++;
      continue;
    }

    // Detect $tag$ delimiter
    if (ch === '$') {
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        const tag = m[0];
        if (dollarTag === null) {
          dollarTag = tag;
        } else if (dollarTag === tag) {
          dollarTag = null;
        }
        current += tag;
        i += tag.length;
        continue;
      }
    }

    if (ch === ';' && dollarTag === null) {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const last = current.trim();
  if (last.length > 0) statements.push(last);
  return statements;
}
