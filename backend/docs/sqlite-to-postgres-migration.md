# SQLite → PostgreSQL data migration

This document describes the first durable execution slice for issue #251.

## Current scope

Implemented:

- read-only SQLite source inspection;
- `integrity_check` and `foreign_key_check`;
- source schema/table/primary-key/dependency inventory;
- full-backup comparison by schema version, schema hash and per-table row counts;
- PostgreSQL target schema and emptiness inspection;
- dependency-ordered migration plan;
- durable migration run, table checkpoint and batch checkpoint schema;
- idempotent apply-plan creation;
- table-level leases with expired-lease takeover;
- machine-readable dry-run CLI report.

Not enabled yet:

- copying business rows;
- type conversion and sequence repair;
- independent verification;
- rollback execution;
- production read/write switching.

The CLI deliberately exposes only `--dry-run` until the copy worker is complete.

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

A non-empty target is rejected by default. The explicit override is:

```bash
--allow-non-empty-target
```

Using the override only changes preflight planning. It does not enable data copying.

## Safety model

- The source SQLite connection is opened with `readonly`, `fileMustExist` and `query_only`.
- Paths in reports are reduced to file names.
- Row contents, credentials, tokens and document bodies are never logged.
- FTS, vector and SQLite internal tables are excluded and deferred to #252.
- A verified full backup is mandatory before an apply plan can be persisted.
- Durable checkpoints are stored only in PostgreSQL.
- Table claims use lease tokens and `FOR UPDATE SKIP LOCKED`.
- An expired lease can be safely reclaimed after process restart.
- Reusing an idempotency key with a different plan is rejected.

## Next execution slice

The next slice will consume table checkpoints and implement:

1. consistent SQLite snapshot acquisition;
2. batched primary-key cursor reads;
3. PostgreSQL transactional upserts;
4. BOOLEAN/TIMESTAMPTZ/BYTEA/JSON conversion;
5. batch checkpoint persistence;
6. table and run verification;
7. rollback of rows owned by a migration run.
