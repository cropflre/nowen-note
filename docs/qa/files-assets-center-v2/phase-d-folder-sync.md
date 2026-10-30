# Phase D3 — personal attachment directory synchronization

Base: `release/v1.5.2` at `2f0f950c`. D1 (#847) and D2 (#849) are merged; this module is independently reviewed and is not completion or release of all Phase D.

Integration follow-up: target commit `2de512b6` (calendar/mobile repair) was merged into this feature branch. The CHANGELOG conflict retains both the calendar entry and the current D1–D3 status; calendar source changes are preserved.

## Contract and implementation

- Personal attachment folders (create, rename, reparent, empty-folder deletion) and file locations use the negotiated `attachment_organization` entity. `folder:<id>` / `file:<id>` identities retain the original folder and attachment IDs. Bytes, SHA-256, storage paths and note ownership keep their existing channel.
- The ten-entity legacy subscription and eleven-entity tree subscription remain unchanged. The new twelve-entity subscription requires an advertised capability, complete Snapshot and subscription ACK. Previously bound clients refuse silent downgrade. Signed-in folder writes are unavailable until the current profile has completed binding; device-only Native organization remains local.
- SQLite v129 preserves historical queues, mutation IDs, retry state, resolved conflicts, indexes, triggers and the monotonically increasing Feed high-water mark. It adds a versioned metadata/tombstone ledger and profile readiness. Native schema v12 widens existing queues transactionally and retains device folders and assignments. Backup snapshots include these tables; restore invalidates desktop readiness before another reconciliation.
- Desktop SQL triggers capture metadata and its Outbox mutation in the business transaction. Native directory operations validate ownership and commit business rows, metadata and Outbox together. Failures roll back the operation. Existing local folders enter the first baseline without duplicating their IDs; differing existing organization is retained in the conflict ledger.
- Push checks the independent metadata base version, scoped ownership, folder ancestry, same-level names and empty-folder deletion. Missing deleted destinations conflict instead of being retried as new parents. Server writes select canonical business fields rather than trusting client ownership, lifecycle, timestamps or arbitrary metadata.
- Repeated requests use the original mutation ID. Native sends one immutable mutation per organization identity per round, so a later edit cannot bypass an earlier conflict in the same request. ACKs require a positive version; subsequent edits rebase after that exact ACK. Missing/invalid ACKs preserve the queue.
- Pull validates identity, version and graph before advancing its cursor. It loads the final folder dependencies even when a change page ends before a newly created parent. Organization Apply is atomic, and never removes attachment bytes. Remote tombstones cannot resurrect; local parent context needed by unresolved offline positions stays until those dependent intentions are resolved.
- Both versions remain in the existing conflict center. Users choose local/server organization individually; raw JSON merging and bulk replacement are unavailable for this entity. The file explorer refreshes its folder/file view after Native Apply, with the existing account/server/workspace response guards.

## Validation

Only isolated worktree/test-fixture databases were used. The user's real database was not opened or migrated.

Commands:

```sh
node scripts/data-consistency-contract.mjs --verify
node scripts/data-consistency-contract.mjs --backend # use a fresh DB_PATH, or the isolated runner below
node scripts/data-consistency-contract.mjs --frontend
npm run build:all
(cd backend && npx tsc --noEmit)
(cd frontend && npm run test:run -- src/lib/__tests__/nativeTreeSchemaMigration.test.ts src/lib/encryptedNotes/__tests__/nativeDatabaseInitialization.test.ts src/lib/__tests__/mobileLocalAttachmentFolderBridge.test.ts src/lib/__tests__/mobileNativeTreeSubscription.test.ts src/components/fileExplorer/__tests__/FileExplorer.scope.test.tsx src/components/__tests__/ConflictCenterBulkResolve.test.tsx src/i18n/__tests__/releaseI18nCoverage.test.ts)
```

For the final backend run, every backend file in the same DCC matrix was executed with the existing `runTestFile` export from `backend/scripts/run-tests-serial.mjs`. It passes the isolation preload as a command-line argument to each suite, not through `NODE_OPTIONS`: restart tests must inherit their fixture DB path without running another isolation preload. Raw repeated CLI runs can reuse `backend/data`; the isolation runner avoids that fixture residue. An attempted global-preload run invalidated the task-composer restart fixture and is not counted as product-test evidence.

The isolated backend run can be reproduced from the repository root:

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
import { runTestFile } from './backend/scripts/run-tests-serial.mjs';
const matrix = JSON.parse(fs.readFileSync('docs/architecture/data-consistency-contract.matrix.json', 'utf8'));
const files = [...new Set(matrix.policies.flatMap(p => p.checks.map(c => c.file)).filter(f => f.startsWith('backend/')))];
for (const file of files.sort()) {
  const result = await runTestFile(file.slice('backend/'.length), file);
  console.log(result.status, file);
  if (result.status !== 'passed') throw new Error(result.stdout + result.stderr);
}
JS
```

Behavioral coverage:

- Three independent on-disk Native SQLite clients and the real HTTP Sync V2 server: offline nested directory creation, rename/move/delete, restart, file placement in both directions, retained attachment ID/path/hash, initial legacy folders, dropped creation ACK, edits during delayed ACK, invalid ACK, concurrency, explicit resolution, tombstones, enqueue failure, Apply failure and Feed pagination dependencies.
- An independent desktop SQLite replica against the real Hono protocol routes: capability binding, SQL-trigger capture, offline queue retention, coalesced creation/rename, Web-to-desktop movement and deletion.
- An actual old-CHECK SQLite migration fixture: queue order, retry count/error, resolved history, trigger/index reinstallation, idempotence, foreign keys and Feed high-water retention.
- Real SQLite Native schema upgrade and directory facade: retained local folder, denied unbound writes, atomic enqueue failure, expired session and migration failure rollback. Stale schema-9 expectations in the initialization tests now assert schema 12, restoring their guard-order assertions.
- React file-explorer refresh and identity isolation; existing conflict-center regressions; changed-file lint and bilingual translation coverage.

Final local results (2026-10-15):

| Check | Result |
| --- | --- |
| DCC mapping | 12 invariants, 151 references |
| Backend DCC matrix, isolated serial runner | 17 suites, 247 passed, 0 failed |
| Frontend DCC | 25 suites, 230 passed, 0 failed |
| Additional protocol, bootstrap, readiness, old-subscription and folder repository suites | 8 suites, 98 passed |
| Targeted explorer/conflict/subscription/folder/i18n suites | 5 suites, 54 passed |
| Backend TypeScript; frontend TypeScript and production bundles | Passed |
| Changed feature-source ESLint and diff whitespace check | Passed |

Source/build/SQLite evidence is separate from installed-device acceptance. No external CI success is implied. Large-bundle warnings remain.

## Merge acceptance follow-up

PR #850's encrypted-note CI exposed a compatibility failure during the new attachment baseline: replaying the full snapshot rejected negative root positions generated beside the hidden root-document container (`-2147483647`). Desktop snapshot/structure validation and Native validation now accept signed safe integers; fractions, non-finite values and unsafe integers are still rejected. Native schema v12 removes only the nonnegative tree-order CHECK in one transaction, retaining all existing tree rows and queues, with rollback coverage for an interrupted rebuild.

- The failing encrypted-note CI command was reproduced locally: 3 failures before the fix, all 160 tests pass after it.
- Desktop tree snapshot/incremental/structural regressions and encrypted-note scenarios: 8 passed.
- Real HTTP Native multi-device, desktop asset binding and tree engine/baseline regressions: 78 passed, including signed root positions and subsequent directory convergence on independent Native databases.
- Native migration, encrypted guard initialization, negotiation and signed numeric validation: 40 passed, including schema-11 row/queue preservation and failed-migration rollback.
- Existing Issue 612 frontend source-string assertion and lint failures are unrelated to the modified paths; their files are unchanged by this PR.

## Compatibility and acceptance limits

This module covers the existing **personal directory model on SQLite**. Workspace folders, tag/smart-folder synchronization, Native recycle-bin writes, full lifecycle synchronization and PostgreSQL Sync V2 are not added here. Server trash/restore metadata updates Native active-file visibility; that does not enable Native trash mutations. Existing server recycle-bin permission and reference checks remain authoritative.

Native capability negotiation must complete online before the first signed-in directory write. Later offline edits remain local and queued; neither a successful local write nor a server ACK proves a second device has applied the position. Conflict history retains both sides; a deleted folder must be recreated with a new identity rather than revived by an old mutation.

Installed Electron, Android/iOS devices, production S3/PostgreSQL, physical network loss and process-kill acceptance were not run. A temporary SQLite/HTTP network-failure fixture is not that acceptance. Existing large frontend bundle warnings remain. No release or automatic merge is performed by implementing this module.

Remaining Phase D: similar-image search and further advanced organization. Phase E AI is not included.
