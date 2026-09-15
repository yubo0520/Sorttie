import { DatabaseSync } from "node:sqlite";

export const LATEST_SCHEMA_VERSION = 3;

const MIGRATION_1 = `
CREATE TABLE organization_plans (
    plan_id TEXT PRIMARY KEY,
    watched_root TEXT NOT NULL,
    watched_root_identity TEXT,
    plan_hash TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN (
        'frozen', 'executing', 'completed', 'stale', 'abandoned'
    )),
    created_at TEXT NOT NULL,
    frozen_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE TABLE organization_plan_items (
    plan_item_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES organization_plans(plan_id)
        DEFERRABLE INITIALLY DEFERRED,
    ordinal INTEGER NOT NULL,
    registered_file_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    category TEXT NOT NULL,
    conflict_policy TEXT NOT NULL CHECK (conflict_policy IN (
        'fail', 'skip', 'user_renamed'
    )),
    risk_accepted INTEGER NOT NULL CHECK (risk_accepted IN (0, 1)),
    expected_strategy TEXT NOT NULL CHECK (expected_strategy IN (
        'same_volume_rename', 'copy_verify_delete'
    )),
    protection_level TEXT NOT NULL CHECK (protection_level IN (
        'none', 'weak_warning', 'strong_block'
    )),
    protection_summary TEXT NOT NULL,
    protection_evidence_json TEXT NOT NULL,
    source_volume_id TEXT,
    source_file_id TEXT,
    source_size_bytes INTEGER NOT NULL CHECK (source_size_bytes >= 0),
    source_mtime_ns TEXT,
    source_birthtime_ns TEXT,
    source_attributes INTEGER,
    source_reparse_tag INTEGER,
    source_partial_hash TEXT,
    UNIQUE (plan_id, ordinal),
    UNIQUE (plan_id, source_path),
    UNIQUE (plan_id, destination_path)
);

CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES organization_plans(plan_id),
    plan_item_id TEXT NOT NULL REFERENCES organization_plan_items(plan_item_id),
    operation_kind TEXT NOT NULL CHECK (operation_kind = 'organize'),
    strategy TEXT NOT NULL CHECK (strategy IN (
        'same_volume_rename', 'copy_verify_delete'
    )),
    phase TEXT NOT NULL CHECK (phase = 'prepared'),
    source_path TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (plan_item_id, operation_kind)
);

CREATE TABLE operation_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL REFERENCES operations(operation_id),
    phase TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    details_json TEXT NOT NULL
);

CREATE INDEX operations_by_plan
    ON operations(plan_id, operation_id);

CREATE INDEX operation_events_by_operation
    ON operation_events(operation_id, event_id);

CREATE TRIGGER frozen_plan_fields_are_immutable
BEFORE UPDATE OF watched_root, watched_root_identity, plan_hash, created_at, frozen_at
ON organization_plans
BEGIN
    SELECT RAISE(ABORT, 'frozen plan is immutable');
END;

CREATE TRIGGER frozen_plan_cannot_be_deleted
BEFORE DELETE ON organization_plans
BEGIN
    SELECT RAISE(ABORT, 'frozen plan is immutable');
END;

CREATE TRIGGER frozen_plan_item_cannot_be_inserted
BEFORE INSERT ON organization_plan_items
WHEN EXISTS (
    SELECT 1 FROM organization_plans WHERE plan_id = NEW.plan_id
)
BEGIN
    SELECT RAISE(ABORT, 'frozen plan items are immutable');
END;

CREATE TRIGGER frozen_plan_item_cannot_be_updated
BEFORE UPDATE ON organization_plan_items
WHEN EXISTS (
    SELECT 1 FROM organization_plans WHERE plan_id = OLD.plan_id
)
BEGIN
    SELECT RAISE(ABORT, 'frozen plan items are immutable');
END;

CREATE TRIGGER frozen_plan_item_cannot_be_deleted
BEFORE DELETE ON organization_plan_items
WHEN EXISTS (
    SELECT 1 FROM organization_plans WHERE plan_id = OLD.plan_id
)
BEGIN
    SELECT RAISE(ABORT, 'frozen plan items are immutable');
END;
`;

const MIGRATION_2 = `
ALTER TABLE organization_plan_items ADD COLUMN source_dev TEXT;
ALTER TABLE organization_plan_items ADD COLUMN source_ino TEXT;
ALTER TABLE organization_plan_items
    ADD COLUMN source_identity_available INTEGER NOT NULL DEFAULT 0
    CHECK (source_identity_available IN (0, 1));

DROP INDEX operations_by_plan;
DROP INDEX operation_events_by_operation;

ALTER TABLE operation_events RENAME TO operation_events_v1;
ALTER TABLE operations RENAME TO operations_v1;

CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES organization_plans(plan_id),
    plan_item_id TEXT NOT NULL REFERENCES organization_plan_items(plan_item_id),
    operation_kind TEXT NOT NULL CHECK (operation_kind = 'organize'),
    strategy TEXT NOT NULL CHECK (strategy IN (
        'same_volume_rename', 'copy_verify_delete'
    )),
    phase TEXT NOT NULL CHECK (phase IN (
        'prepared', 'moving', 'copying', 'destination_committed',
        'source_removing', 'source_removed', 'completed', 'failed',
        'manual_review'
    )),
    source_path TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (plan_item_id, operation_kind)
);

CREATE TABLE operation_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL REFERENCES operations(operation_id),
    phase TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    details_json TEXT NOT NULL
);

INSERT INTO operations (
    operation_id, plan_id, plan_item_id, operation_kind, strategy, phase,
    source_path, destination_path, created_at, updated_at
)
SELECT operation_id, plan_id, plan_item_id, operation_kind, strategy, phase,
       source_path, destination_path, created_at, updated_at
FROM operations_v1;

INSERT INTO operation_events (
    event_id, operation_id, phase, recorded_at, details_json
)
SELECT event_id, operation_id, phase, recorded_at, details_json
FROM operation_events_v1;

DROP TABLE operation_events_v1;
DROP TABLE operations_v1;

CREATE INDEX operations_by_plan
    ON operations(plan_id, operation_id);

CREATE INDEX operation_events_by_operation
    ON operation_events(operation_id, event_id);

CREATE TRIGGER operation_intent_is_immutable
BEFORE UPDATE OF operation_id, plan_id, plan_item_id, operation_kind, strategy,
                 source_path, destination_path, created_at
ON operations
BEGIN
    SELECT RAISE(ABORT, 'operation intent is immutable');
END;
`;

const MIGRATION_3 = `
CREATE TABLE file_favorites (
    file_id TEXT PRIMARY KEY CHECK(length(file_id) = 64),
    watched_root TEXT NOT NULL,
    file_path TEXT NOT NULL,
    identity_token TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX favorites_by_root ON file_favorites(watched_root);
`;

const migrations = [MIGRATION_1, MIGRATION_2, MIGRATION_3] as const;

export function openSorttieDatabase(filename: string): DatabaseSync {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  migrateDatabase(database);
  return database;
}

export function migrateDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
    )
  `);

  const currentVersion = getSchemaVersion(database);
  if (currentVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema ${currentVersion} is newer than supported schema ${LATEST_SCHEMA_VERSION}.`,
    );
  }
  for (let version = currentVersion + 1; version <= LATEST_SCHEMA_VERSION; version += 1) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migrations[version - 1]);
      database.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(version, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function getSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
  ).get() as { version: number };
  return Number(row.version);
}
