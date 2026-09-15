# Trusted file operations kernel

## Status

This document records the accepted engineering baseline for Sorttie's first
trusted file-operation slice. It is a design contract, not authorization to
move files yet. The current application remains read-only until the relevant
implementation slice and its tests are explicitly approved.

The acceptance standard is:

> Sorttie's first trusted version is not judged by how intelligent its
> classification is. A user must understand the plan before execution, files
> must not be lost during execution, interrupted work must be recoverable,
> completed work must be safely undoable, and referenced project media must not
> be moved accidentally.

## Scope and deliberate constraints

- Start with one concrete `LocalFileOperationService` in Electron main.
- Do not add a storage-provider interface, factory, or plugin layer while only
  one implementation exists.
- Renderer sends registered file IDs and explicit user decisions. It never
  sends an arbitrary source path or invokes Node filesystem APIs.
- Main resolves each ID from its current registry and revalidates the watched
  root, first-level boundary, link status, identity, protection evidence, and
  destination immediately before mutation.
- The reviewed organization plan is immutable. Execution never reruns
  classification or silently chooses a different destination or conflict
  policy.
- An immutable plan does not bypass preflight. Changed preconditions make an
  item stale or require review; they do not authorize the executor to improvise.
- One mutation run may be active at a time. Organize, recovery, and undo runs
  share the same operation lock.
- Multi-file drag-out remains an operating-system convenience. It is outside
  Sorttie's transaction history and undo promise.
- AI classification, remote storage, project adapters, and cross-volume moves
  are separate later slices.

## Domain records and lifetimes

The following records have different purposes and must not be collapsed into a
single renderer `files` state:

1. **File activity events** describe what Sorttie observed.
2. **Classification suggestions and user corrections** describe organization
   intent and may be recomputed or replaced.
3. **Frozen organization plans** describe exactly what the user reviewed.
4. **Operation runs, item journal entries, and receipts** authorize recovery
   and undo and must be durable.
5. **Project-reference evidence** records where a protection conclusion came
   from, its strength, and when it was observed.

Logical separation does not require separate database files. The initial
implementation may keep these concerns in separate tables in one SQLite
database under Electron's `app.getPath("userData")`.

## Frozen organization plan

Opening an organization preview creates a frozen plan. Each entry contains at
least:

- `planId`, `planItemId`, creation time, watched-root identity, and plan hash;
- registered file ID for UI correlation;
- canonical source and destination paths;
- the selected category and conflict policy;
- a source identity snapshot;
- the project-protection decision and the evidence used to reach it;
- whether the operation is expected to use same-volume rename or later
  cross-volume copy/verify/delete.

Plan items are never edited in place. Returning from preview and changing a
category, destination, conflict choice, or selected file creates a new plan (or
a new immutable revision with a new hash). The executor accepts a `planId` and
expected `planHash`; it does not accept replacement paths from renderer.

## File identity and validation cost

Identity is layered because no single signal works on every filesystem:

- On supported Windows local filesystems, prefer volume identity plus Windows
  file ID.
- Always retain size, modification time, creation time when available, file
  attributes, and reparse/link information as supporting evidence.
- A partial hash is a matching hint only. It is never sufficient by itself to
  authorize deletion of a source file.
- A cross-volume copy computes a full cryptographic hash while streaming the
  copy, avoiding an unnecessary extra source read.
- A provider-specific revision or ETag may be added only when a real second
  storage implementation exists.

File ID can change across volumes and may be unavailable or reusable on some
filesystems. Recovery and undo therefore validate an appropriate combination
of storage identity, metadata, and content hash for the operation strategy.

The first read-only inspector uses Node's BigInt `lstat` result. It records
`dev` and `ino` as decimal text when both are nonzero and treats that pair as a
stronger identity signal available on the current filesystem—not as a
portable or authoritative Windows File ID. Size, modification time, and birth
time remain the metadata fallback. Node-visible symbolic links and junctions
are rejected without following them. Native Windows file identity and generic
reparse-tag inspection remain a separate hardening slice.

## Read-only inspect and preflight

`LocalFileOperationService.inspect(operationId)` and `preflight(operationId)`
accept no path arguments. Main resolves the persisted operation, frozen plan,
and plan item before inspecting the filesystem. Preflight checks the operation
phase and plan state, the first-level watched-root boundary, source type and
identity, source/destination equality, destination parent, frozen conflict
policy, and destination conflict state.

The result is either `ready` with structured source and destination
inspections or `blocked` with stable reason codes. Missing entries and expected
filesystem races are results rather than generic thrown errors. The service
does not create directories, probe writability with temporary files, read file
contents, append operation events, or change operation state. Execution must
run this same preflight again immediately before its first side effect.

## State machines

Journal state is the last fact Sorttie durably confirmed. It is not a claim
that the next filesystem call did or did not happen. Every recovery decision
must compare the journal with the real source, temporary, and destination
entries.

### Same-volume atomic rename

```text
prepared
  -> moving
  -> completed
```

`moving` is persisted before calling the no-overwrite rename. A same-volume
rename has no valid intermediate state in which both a committed destination
and the original source are part of the intended result. If the process stops
between the system call and the next transaction, startup reconciliation
checks both paths and their identities before completing or retrying.

### Cross-volume copy, verify, commit, and remove

```text
prepared
  -> copying
  -> destination_committed
  -> source_removing
  -> source_removed
  -> completed
```

`copying` is persisted before the first write. Data is written in the final
destination directory under an operation-owned temporary name:

```text
<filename>.sorttie-<operationId>.partial
```

The copy is closed and flushed, its size and full hash are verified, and only
then is the temporary entry atomically renamed to the final destination name.
`destination_committed` is persisted after that final name has been verified.
`source_removing` is persisted before removing the unchanged source;
`source_removed` is persisted only after the source is confirmed absent.

Sorttie never overwrites an existing destination as an incidental consequence
of rename or recovery. The conflict decision must already exist in the frozen
plan.

## Recovery reconciliation

The matrix below describes the minimum recovery rules. “Matches” means the
identity and verification evidence required by the operation strategy agree
with the frozen plan and journal receipt.

| Journal phase | Source | Partial | Final destination | Recovery action |
| --- | --- | --- | --- | --- |
| `prepared` | matches | absent | absent | Safe to preflight again; no side effect is assumed. |
| `moving` | matches | n/a | absent | The atomic rename did not commit; preflight before retrying. |
| `moving` | absent | n/a | matches | Rename committed; persist `completed`. |
| `moving` | present | n/a | present | Stop for conflict investigation; do not delete either entry. |
| `copying` | matches | absent | absent | Copy did not start or was cleaned; preflight before retrying. |
| `copying` | matches | owned partial | absent | Validate ownership, remove only this operation's partial, then retry from the source. |
| `copying` | matches | absent | matches | Final rename committed before the journal update; persist `destination_committed`. |
| `destination_committed` | matches | absent | matches | Revalidate the unchanged source, persist `source_removing`, then continue the approved removal. |
| `source_removing` | matches | absent | matches | Removal did not complete; continue only if source and destination still match. |
| `source_removing` | absent | absent | matches | Removal committed before the journal update; persist `source_removed`. |
| `source_removed` | absent | absent | matches | Persist `completed`. |
| any phase | absent | any | absent | Critical inconsistency: report and require manual investigation. |
| any phase | changed | any | any | Stop automatic recovery; preserve all surviving data and require review. |

Recovery may automatically repair a missing journal transition when reality is
unambiguous and identities match. It must not infer content identity from a
filename, delete an unverified complete file, or clean a temporary file that is
not provably owned by the same `operationId`.

## Undo semantics

Undo is a new validated operation, not a blind reversal of strings:

- it references the original operation and item receipts;
- it confirms the current destination is the exact output Sorttie committed;
- it confirms the original source path is free or applies the conflict decision
  the user explicitly approves;
- it reruns project-protection checks relevant to the reverse move;
- it uses same-volume rename or cross-volume copy/verify/delete according to the
  current volumes;
- it journals and recovers with the same guarantees as a forward operation;
- changed, missing, or ambiguous files are skipped and reported rather than
  overwritten or guessed.

## Watcher correlation

The filesystem watcher will observe Sorttie's own changes. Each operation item
therefore carries an `operationId`, and the main process correlates matching
remove/add/change events with that operation. Events are still recorded, but
the UI can truthfully label them as performed by Sorttie instead of reporting
an unrelated external deletion and creation.

Correlation is not global event suppression: unrelated activity in the watched
directory must continue to appear.

## Initial SQLite schema design

The first migration deliberately models one local implementation and contains
no provider factory or AI tables. Its identifiers have distinct lifetimes:

- `planId` identifies the complete immutable review decision;
- `planItemId` identifies one file intent at a stable ordinal in that plan;
- `operationId` is created and persisted when that item first enters the
  organize execution flow. Reopening the database or retrying preparation for
  the same item returns that operation instead of creating another ID.

There is no fourth operation-item identity in this slice. One operation row is
the durable journal root for one plan item. A later undo operation will receive
its own `operationId` and reference the forward operation when undo is added.

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

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
    source_dev TEXT,
    source_ino TEXT,
    source_identity_available INTEGER NOT NULL DEFAULT 0 CHECK (
        source_identity_available IN (0, 1)
    ),
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

CREATE INDEX operations_by_plan
    ON operations(plan_id, operation_id);

CREATE INDEX operation_events_by_operation
    ON operation_events(operation_id, event_id);
```

Migration 2 adds the `lstat` identity fields, broadens the persisted operation
phase constraint for later journal transitions, and makes operation intent
fields immutable while leaving `phase` and `updated_at` available to the later
journal slice. Nanosecond timestamps are stored as decimal text because
contemporary epoch nanoseconds exceed JavaScript's safe integer range. The
plan store inserts all
items and the parent plan in one transaction using a deferred foreign key. The
parent is inserted last, so a failed freeze cannot leave a visible partial
plan. Database triggers then reject insert, update, or delete attempts against
the committed items and reject changes to the plan's immutable reviewed
fields.

The migration records its version transactionally and may be run repeatedly.
Creating a prepared operation and its first event is also one transaction.
Later state transitions will update the operation row and append an event in
the same transaction. Paths remain private local data under `userData`; they
are not exposed through a generic renderer query.

## Implementation sequence

1. Add the SQLite migration, `operationId`, frozen-plan types, and schema tests.
2. Build and hash immutable organization plans without file mutation.
3. Implement Windows identity snapshots and read-only preflight.
4. Implement journal transitions and startup reconciliation with injected
   interruption tests, still without enabling UI execution.
5. Enable same-volume no-overwrite moves behind explicit reviewed-plan
   confirmation.
6. Add durable, revalidated undo.
7. Add cross-volume copy, full verification, atomic destination commit, and
   source removal.
8. Add project-reference evidence; strong evidence blocks and weak evidence
   warns.
9. Treat multi-file drag-out as a separate non-transactional convenience.
10. Decide whether AI classification provides enough value to justify its own
    later architecture.

## Test boundaries

- Pure tests cover plan canonicalization, hashing, allowed transitions, and the
  entire reconciliation matrix.
- SQLite tests use temporary databases and verify migrations, constraints,
  transactions, and append-only events.
- Filesystem integration tests use only temporary directories and inject a
  stop after every journal transition and filesystem call.
- Same-volume tests and cross-volume tests are separate; environments without
  two real volumes must not pretend that two directories exercise cross-volume
  semantics.
- Recovery tests inspect real source, partial, and destination states instead
  of mocking away the reconciliation boundary.
- Tests never scan or mutate the user's real Downloads directory.
- Renderer state tests, visual screenshot tests, deterministic filesystem
  tests, and optional slow/environment-dependent tests remain separate suites
  with separately owned artifacts.

## UI wording consequence

Before real execution is enabled, preview text may say that no operation is
currently being performed. Once moves are real, the UI must not claim that the
source file will remain at its original path. It should state that Sorttie will
move the approved files, will not permanently delete them as an unrelated
action, and will record a validated undo transaction.
