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
