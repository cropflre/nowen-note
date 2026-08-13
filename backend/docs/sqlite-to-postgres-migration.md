# SQLite → PostgreSQL data migration

This document describes the durable SQLite → PostgreSQL migration runtime for issue #251.

## Current scope

Implemented:

- read-only SQLite source inspection with `integrity_check` and `foreign_key_check`;
- verified frozen-backup comparison by schema version, schema hash and per-table row counts;
- PostgreSQL target schema and emptiness inspection;
- dependency-ordered migration plans;
- durable run, table, batch and run-owned row checkpoints;
- table leases with expired-lease takeover;
- stable primary-key keyset pagination;
- transactional business upsert + ownership record + checkpoint commits;
- restart/resume and idempotent replay;
- INTEGER `0/1` → BOOLEAN, timestamp, JSON/JSONB, BYTEA and BIGINT-safe conversion;
- nullable self-reference repair and identity/sequence repair;
- copy-time and independent row-count/checksum verification;
- empty-target rollback;
- explicit non-empty-target conflict handling and typed original-row restoration;
- concurrent modification protection during rollback;
- scalable apply → verify → rollback drills;
- persisted and file-based machine-readable final reports.

Still outside this migration runtime:

- FTS and vector rebuild, tracked by #252;
- PostgreSQL backup and restore, tracked by #253;
- deployment, cutover, rollback rehearsal and production switching, tracked by #254.

`businessRoutesReady` remains `false` until the remaining PostgreSQL work is complete.

## Safety model

- SQLite files are opened with `readonly`, `fileMustExist` and `query_only`.
- The live source is used only for preflight.
- Apply and verify read only the verified frozen backup.
- Source and backup paths are reduced to file-name hints in reports.
- Credentials, tokens, document bodies and business row contents are not logged.
- Every migrated table must have a stable primary key.
- Cross-table foreign-key cycles remain blockers; nullable self-references use a recoverable second pass.
- Business writes, run-owned row tracking and checkpoints commit in the same PostgreSQL transaction.
- A transaction failure leaves neither a partial business row nor a completed checkpoint.
- Reusing an idempotency key with a different source, plan, batch size or conflict policy is rejected.
- Rollback deletes only run-owned inserted rows and restores only snapshotted updated rows.
- Rollback verifies the exact migrated row before changing it; newer user changes stop rollback instead of being overwritten.
- FTS, vector and SQLite internal tables are excluded.

## Preflight

```bash
cd backend
DATABASE_URL='postgres://...' \
npm run migrate:sqlite-to-postgres -- \
  --dry-run \
  --source /path/to/nowen-note.db \
  --backup /path/to/nowen-note.backup.db
```

Dry-run does not write PostgreSQL business data. It exits with code `2` while safety blockers remain.

## Empty-target apply

Use one stable idempotency key for the complete attempt:

```bash
DATABASE_URL='postgres://...' \
npm run migrate:sqlite-to-postgres -- \
  --apply \
  --source /path/to/nowen-note.db \
  --backup /path/to/nowen-note.backup.db \
  --idempotency-key migration-2026-08-06 \
  --batch-size 200
```

Valid batch size is `1..2000`; the default is `200`.

## Non-empty-target apply

A non-empty target requires two explicit controls:

```bash
DATABASE_URL='postgres://...' \
npm run migrate:sqlite-to-postgres -- \
  --apply \
  --source /path/to/nowen-note.db \
  --backup /path/to/nowen-note.backup.db \
  --idempotency-key migration-2026-08-06 \
  --allow-non-empty-target \
  --conflict-policy overwrite-with-backup
```

Each source primary key is classified in the same transaction as the upsert:

- `inserted`: no target row existed before migration;
- `updated`: a target row existed and changed; the complete typed original row is retained;
- `unchanged`: the target row already matched the migrated result.

Unrelated target rows are preserved and excluded from source parity checks.

## Independent verification

```bash
DATABASE_URL='postgres://...' \
npm run migrate:sqlite-to-postgres -- \
  --verify \
  --backup /path/to/nowen-note.backup.db \
  --idempotency-key migration-2026-08-06
```

Verification re-reads the frozen backup and PostgreSQL in primary-key order and compares canonical row counts and checksums.

## Rollback

```bash
DATABASE_URL='postgres://...' \
npm run migrate:sqlite-to-postgres -- \
  --rollback \
  --idempotency-key migration-2026-08-06
```

Rollback runs in reverse dependency order. It deletes inserted rows, restores updated rows, leaves unchanged rows untouched and is resumable and idempotent.

## Migration drill

The drill command exercises the complete reversible path:

```text
apply
→ independent verify
→ rollback
→ post-rollback primary-key/count/checksum validation
→ foreign-key orphan validation
→ final report persistence
```

### Empty-target drill

```bash
DATABASE_URL='postgres://...' \
npm run migrate:sqlite-to-postgres:drill -- \
  --source /path/to/nowen-note.db \
  --backup /path/to/nowen-note.backup.db \
  --idempotency-key drill-2026-08-06 \
  --batch-size 200 \
  --max-batches-per-pass 10 \
  --max-rollback-batches-per-pass 10 \
  --report /secure/path/sqlite-postgres-drill-report.json
```

### Non-empty-target drill

```bash
DATABASE_URL='postgres://...' \
npm run migrate:sqlite-to-postgres:drill -- \
  --source /path/to/nowen-note.db \
  --backup /path/to/nowen-note.backup.db \
  --idempotency-key drill-nonempty-2026-08-06 \
  --allow-non-empty-target \
  --conflict-policy overwrite-with-backup \
  --batch-size 200 \
  --max-batches-per-pass 10 \
  --max-rollback-batches-per-pass 10 \
  --report /secure/path/sqlite-postgres-drill-report.json
```

The pass limits deliberately bound one invocation and exercise persisted resume behavior. Omit them for an uninterrupted local drill.

The report is written to the requested file and persisted in `sqlite_postgres_migration_runs.report`. It includes:

- source/backup file-name hints and sizes;
- table and row totals;
- apply and rollback pass counts;
- inserted, updated, unchanged, deleted and restored row totals;
- independent verification details;
- post-rollback primary-key, row-count and checksum results;
- PostgreSQL foreign-key orphan findings;
- concurrent conflict and failure totals;
- duration and a conservative free-space recommendation.

## Operator runbook

Before execution:

1. Stop or quiesce writes to the SQLite source.
2. Create a full backup and retain the original source.
3. Bootstrap the target PostgreSQL schema.
4. Confirm free disk capacity for the source, frozen backup, PostgreSQL data and a verified PostgreSQL backup. The drill report recommends at least three times the combined source and frozen-backup size as a conservative floor.
5. Run dry-run and resolve every blocker.
6. Run an apply → verify → rollback drill against a disposable or staging PostgreSQL target.

During execution:

1. Reuse the same idempotency key for retries and resume.
2. Do not replace or modify the frozen backup.
3. Treat checksum, foreign-key or concurrent-modification findings as hard failures.
4. Keep `businessRoutesReady = false`; this tool does not perform application cutover.

After execution:

1. Preserve the final JSON report with deployment records.
2. Keep the original SQLite source and frozen backup until migration verification passes, the rollback window is closed and a PostgreSQL backup has been independently restored and verified.
3. Do not delete SQLite data merely because apply completed.
4. Complete #252, #253 and #254 before production read/write switching.

## Exit codes

Main migration command:

- `0`: requested operation completed successfully;
- `1`: command/runtime failure;
- `2`: dry-run blockers;
- `3`: apply stopped before terminal completion;
- `4`: independent verification mismatch;
- `5`: rollback stopped before terminal completion.

Drill command:

- `0`: apply, verify, rollback and post-rollback validation passed;
- `1`: command/runtime failure;
- `6`: drill completed but the final report is not successful.
