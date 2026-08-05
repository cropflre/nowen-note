# SQLite → PostgreSQL data migration

This document describes the durable preflight, copy and verification slices for issue #251.

## Current scope

Implemented:

- read-only SQLite source inspection;
- `integrity_check` and `foreign_key_check`;
- source schema/table/primary-key/dependency inventory;
- full-backup comparison by schema version, schema hash and per-table row counts;
- PostgreSQL target schema and emptiness inspection;
- dependency-ordered migration plan;
- durable migration run, table checkpoint and batch checkpoint state;
- idempotent apply-plan creation;
- table-level leases with expired-lease takeover;
- primary-key cursor batch reads from a verified frozen backup;
- transactional PostgreSQL upsert + batch checkpoint + table cursor commits;
- INTEGER 0/1 → BOOLEAN conversion;
- SQLite time text → TIMESTAMPTZ conversion;
- BLOB → BYTEA conversion;
- JSON/JSONB validation and conversion;
- BIGINT-safe transfer without JavaScript precision loss;
- nullable self-referencing foreign-key repair after row insertion;
- identity/sequence repair;
- per-batch content checksum and per-table row/checksum verification;
- independent machine-readable `--verify` mode;
- restart/resume and idempotent replay.

Not enabled yet:

- apply into a non-empty target database;
- run-owned row tracking and rollback execution;
- production read/write switching.

FTS and vector tables remain excluded and are rebuilt in #252.

## Dry run

Bootstrap the target PostgreSQL schema first, then run:

```bash
cd backend
DATABASE_URL='postgres://...' \
npm run migrate:sqlite-to-postgres -- \
  --dry-run \
  --source /path/to/nowen-note.db \
  --backup /path/to/nowen-note.backup.db
```

The command is read-only for both the SQLite source and PostgreSQL business data. It exits with code `2` when safety blockers remain.

A non-empty target is rejected by default. `--allow-non-empty-target` only allows risk inspection and plan creation; the current apply executor still refuses to write into a target that was non-empty during preflight.

## Apply

Use one stable idempotency key for the complete migration attempt:

```bash
cd backend
DATABASE_URL='postgres://...' \
npm run migrate:sqlite-to-postgres -- \
  --apply \
  --source /path/to/nowen-note.db \
  --backup /path/to/nowen-note.backup.db \
  --idempotency-key migration-2026-08-05
```

Optional batch size:

```bash
--batch-size 500
```

Valid range is `1..2000`; the default is `200`.

The live source is used only for preflight. All copied rows are read from the verified backup, which acts as the frozen execution snapshot. Each batch commits the following in one PostgreSQL transaction:

1. idempotent row upserts;
2. completed batch checkpoint;
3. primary-key cursor and copied-row progress;
4. run-level copied-row progress.

A process crash before commit leaves no target rows or checkpoint for that batch. A crash after commit resumes from the persisted cursor and does not duplicate rows.

Exit codes:

- `0`: all planned tables copied and verified;
- `1`: command/runtime failure;
- `2`: dry-run blockers;
- `3`: apply stopped before terminal completion;
- `4`: independent verification mismatch.

## Independent verification

```bash
cd backend
DATABASE_URL='postgres://...' \
npm run migrate:sqlite-to-postgres -- \
  --verify \
  --backup /path/to/nowen-note.backup.db \
  --idempotency-key migration-2026-08-05
```

Verification re-reads the frozen SQLite backup and the PostgreSQL target in the same primary-key order. It compares every batch row count and canonical content checksum, covering BOOLEAN, timestamps, JSON, binary values and BIGINT values.

## Safety model

- SQLite is opened with `readonly`, `fileMustExist` and `query_only`.
- The verified backup is the only apply/verify row source.
- Paths in reports are reduced to file names.
- Row contents, credentials, tokens and document bodies are never logged.
- FTS, vector and SQLite internal tables are excluded and deferred to #252.
- Every copied business table must have a stable primary key.
- Cross-table foreign-key cycles remain a preflight blocker; nullable self-references are handled in a recoverable second pass.
- Durable checkpoints are stored only in PostgreSQL.
- Table claims use lease tokens and `FOR UPDATE SKIP LOCKED`.
- Expired leases can be reclaimed after process restart.
- Reusing an idempotency key with a different source, plan or batch size is rejected.
- The source and backup files are never modified.

## Remaining #251 slice

The next slice will add:

1. run-owned primary-key tracking;
2. safe rollback in reverse dependency order;
3. non-empty target conflict policy and restoration records;
4. final migration report persistence;
5. larger generated datasets and failure-injection coverage;
6. cutover readiness signal after successful verify and rollback drill.


## Empty-target rollback

Each apply batch records the migrated row primary key in `sqlite_postgres_migration_row_changes` in the same PostgreSQL transaction as the business upsert and checkpoint. For targets that were empty at preflight, rollback deletes only those run-owned rows in reverse table dependency order.

```bash
npm run migrate:sqlite-to-postgres -- \
  --rollback \
  --idempotency-key migration-2026-08-05
```

Rollback is resumable and idempotent. A run created before ownership tracking, or a run planned against a non-empty target, is rejected rather than guessing a deletion range. Restoring overwritten pre-existing rows remains disabled until original-row snapshots and conflict policies are complete.
