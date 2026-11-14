import type { SqlMigration } from '@substrat-run/kernel';

// ============================================================================
// The vertical's OWN tables, prefixed `sales_` so they can never collide with an
// engine's. Ids are TEXT (ULIDs), timestamps ISO-8601 TEXT, money/decimals TEXT
// — never a float, never a native DATE. Migrations are append-only and ordered:
// once a version has shipped, you add a new one, you never edit it.
// ============================================================================

export const salesMigrations: SqlMigration[] = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE sales_members (
        id           TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        email        TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE TABLE sales_companies (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        domain               TEXT,
        segment              TEXT,
        fit_score            INTEGER,
        fit_reason           TEXT,
        owner_id             TEXT,
        source               TEXT,
        relationship_context TEXT,
        merged_into          TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE INDEX sales_companies_domain ON sales_companies(domain);
      CREATE INDEX sales_companies_name ON sales_companies(name);
      CREATE TABLE sales_contacts (
        id         TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES sales_companies(id),
        name       TEXT NOT NULL,
        role       TEXT,
        email      TEXT,
        phone      TEXT,
        source     TEXT,
        owner_id   TEXT,
        opted_out  INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX sales_contacts_company ON sales_contacts(company_id);
      CREATE INDEX sales_contacts_email ON sales_contacts(email);
      CREATE TABLE sales_opportunities (
        id            TEXT PRIMARY KEY,
        company_id    TEXT NOT NULL REFERENCES sales_companies(id),
        title         TEXT NOT NULL,
        stage         TEXT NOT NULL,
        fit_rationale TEXT,
        value_low     TEXT,
        value_high    TEXT,
        currency      TEXT NOT NULL DEFAULT 'EUR',
        owner_id      TEXT,
        next_step     TEXT,
        target_date   TEXT,
        lost_reason   TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX sales_opportunities_company ON sales_opportunities(company_id);
      CREATE INDEX sales_opportunities_stage ON sales_opportunities(stage);
      CREATE TABLE sales_interactions (
        id                TEXT PRIMARY KEY,
        company_id        TEXT NOT NULL REFERENCES sales_companies(id),
        contact_id        TEXT REFERENCES sales_contacts(id),
        opportunity_id    TEXT REFERENCES sales_opportunities(id),
        kind              TEXT NOT NULL,
        direction         TEXT,
        summary           TEXT NOT NULL,
        customer_quote    TEXT,
        generated         INTEGER NOT NULL DEFAULT 0,
        performed_by_kind TEXT NOT NULL,
        performed_by      TEXT NOT NULL,
        occurred_at       TEXT NOT NULL,
        created_at        TEXT NOT NULL
      );
      CREATE INDEX sales_interactions_company ON sales_interactions(company_id);
      CREATE TABLE sales_tasks (
        id             TEXT PRIMARY KEY,
        company_id     TEXT REFERENCES sales_companies(id),
        opportunity_id TEXT REFERENCES sales_opportunities(id),
        title          TEXT NOT NULL,
        due_date       TEXT NOT NULL,
        owner_id       TEXT,
        done_at        TEXT,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX sales_tasks_due ON sales_tasks(due_date);
      CREATE TABLE sales_knowledge (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        category    TEXT NOT NULL,
        claim_label TEXT,
        source      TEXT NOT NULL,
        source_date TEXT,
        status      TEXT NOT NULL DEFAULT 'draft',
        created_by  TEXT NOT NULL,
        approved_by TEXT,
        approved_at TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE sales_exclusions (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        value      TEXT NOT NULL,
        reason     TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sales_import_batches (
        id            TEXT PRIMARY KEY,
        filename      TEXT NOT NULL,
        uploaded_by   TEXT NOT NULL,
        row_count     INTEGER NOT NULL,
        created_count INTEGER NOT NULL,
        matched_count INTEGER NOT NULL,
        flagged_count INTEGER NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE TABLE sales_import_rows (
        id         TEXT PRIMARY KEY,
        batch_id   TEXT NOT NULL REFERENCES sales_import_batches(id),
        row_number INTEGER NOT NULL,
        raw        TEXT NOT NULL,
        outcome    TEXT NOT NULL,
        note       TEXT,
        company_id TEXT,
        contact_id TEXT
      );
      CREATE INDEX sales_import_rows_batch ON sales_import_rows(batch_id);
      CREATE TABLE sales_duplicates (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        left_id    TEXT NOT NULL,
        right_id   TEXT NOT NULL,
        reason     TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'open',
        batch_id   TEXT,
        decided_by TEXT,
        decided_at TEXT,
        snapshot   TEXT,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: '0002-invites',
    sql: `
      CREATE TABLE sales_invites (
        id         TEXT PRIMARY KEY,
        email      TEXT NOT NULL,
        role_key   TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'open',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        settled_at TEXT
      );
      CREATE INDEX sales_invites_email ON sales_invites(email);
    `,
  },
  {
    version: '0003-meetings',
    sql: `
      CREATE TABLE sales_meetings (
        id                   TEXT PRIMARY KEY,
        company_id           TEXT NOT NULL REFERENCES sales_companies(id),
        opportunity_id       TEXT REFERENCES sales_opportunities(id),
        title                TEXT NOT NULL,
        starts_at            TEXT NOT NULL,
        duration_min         INTEGER NOT NULL DEFAULT 30,
        location             TEXT,
        attendees            TEXT,
        agenda               TEXT,
        status               TEXT NOT NULL DEFAULT 'scheduled',
        owner_id             TEXT,
        recording_consent_by TEXT,
        recording_consent_at TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE INDEX sales_meetings_company ON sales_meetings(company_id);
      CREATE INDEX sales_meetings_starts ON sales_meetings(starts_at);
    `,
  },
  {
    version: '0004-transcripts',
    sql: `
      CREATE TABLE sales_transcript_segments (
        id           TEXT PRIMARY KEY,
        meeting_id   TEXT NOT NULL REFERENCES sales_meetings(id),
        recording_id TEXT,
        seq          INTEGER NOT NULL,
        start_ms     INTEGER NOT NULL,
        end_ms       INTEGER NOT NULL,
        text         TEXT NOT NULL,
        language     TEXT,
        created_by   TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        corrected_by TEXT,
        corrected_at TEXT
      );
      CREATE INDEX sales_transcript_meeting ON sales_transcript_segments(meeting_id, seq);
    `,
  },
  {
    version: '0005-transcript-runs',
    sql: `
      CREATE TABLE sales_transcript_runs (
        id            TEXT PRIMARY KEY,
        meeting_id    TEXT NOT NULL REFERENCES sales_meetings(id),
        recording_id  TEXT,
        model         TEXT NOT NULL,
        language      TEXT,
        diarize       INTEGER NOT NULL DEFAULT 0,
        source        TEXT NOT NULL,
        status        TEXT NOT NULL,
        is_current    INTEGER NOT NULL DEFAULT 0,
        segment_count INTEGER NOT NULL DEFAULT 0,
        failure       TEXT,
        created_by    TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        finished_at   TEXT
      );
      CREATE INDEX sales_transcript_runs_meeting ON sales_transcript_runs(meeting_id);
      CREATE TABLE sales_transcript_speakers (
        id         TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL REFERENCES sales_transcript_runs(id),
        number     INTEGER NOT NULL,
        name       TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX sales_transcript_speakers_run ON sales_transcript_speakers(run_id, number);
      ALTER TABLE sales_transcript_segments ADD COLUMN run_id TEXT;
      ALTER TABLE sales_transcript_segments ADD COLUMN speaker INTEGER;
    `,
  },
];
