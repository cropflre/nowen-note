# Files & Assets Center — Phase C

Baseline: `release/v1.5.2`, `2247abb32a65addf4926ef5f9444a2a6f23ff7b4` (A and B merged).
Branch: `codex/files-assets-center-v2-organize`. Phase C is not merged or released.
This work reused the clean, attached A/B worktree; the original checkout and its unrelated QA artifacts were not edited.

## Delivered scope

| Phase C requirement | Implementation |
| --- | --- |
| Attachment tags | Independent `asset_tags` and `asset_tag_relations`; add/remove in details, Enter to create, sidebar rename/delete |
| Batch tags | Explicit additive add/remove; up to 200 files and 50 tags; validate the entire batch before any relation changes |
| Tag search | Normalized scoped names, server search, 200-row metadata pages; multiple selected filter tags use AND |
| Save filters | Persist category, folder, filename, format, dates, size, tags, reference state and identical-content selection |
| Smart folders | Private saved searches per user/space; create/update/rename/delete; recent searches retain a relative seven-day window |
| Attribute filters | MIME, size range, local-day date boundaries, authorized visible-note usage, combined with existing categories/search/paging |
| Identical content | Existing SHA-256 metadata and authorized same-scope siblings; never infer visual similarity, merge or delete automatically |

Reuses the attachment IDs/URLs/storage, file explorer, detail preview, existing ACL/capability services,
reference index, list/pagination and full-backup database snapshot. No file copy or new binary layout.
The shared filter parser serves the original list and both permission/retention projections;
reference and duplicate permission filtering occurs before the authoritative list pagination.

## Persistence and authorization

- SQLite migration **v127** adds three tables, scoped normalized-name uniqueness, cascading relations and relation-scope guards. It is additive and idempotent. Legacy attachment rows are not rewritten.
- Personal tags are private; workspace tags are shared within that workspace and require editor permission for changes. File tagging additionally requires the current uploader's existing file management permission on every file. Viewer/nonmember and mixed-scope batches fail without partial writes.
- Smart folders belong to their user and workspace. Rules use a server whitelist and bound SQL parameters, not executable SQL. Saving or opening them does not move attachments.
- Deleting a tag or smart folder cannot delete a file. If another existing workflow transfers a file to a different scope, the relation trigger removes incompatible old-scope tags instead of carrying them across spaces.
- The detail duplicate list and reference filters do not expose unauthorized files or note titles/counts. Legacy files without hashes are not treated as duplicates by filename.
- New writes use the existing authenticated request transport; failed requests retain UI state and display an error. No offline-success or synchronization receipt is fabricated.
- Native device-only and signed-in modes report organization unavailable. Metadata writes/new organization filters fail before personal SQL or remote fallback. Basic Native recently-added browsing remains supported and has a regression test.
- No Sync V2 registry, mutation, ACK or cursor change is introduced. These new server-owned metadata tables are not Native sync entities.

## Executed validation

macOS, Node **24.18.0 / ABI 137**, isolated synthetic SQLite data, production frontend, real full backend and Playwright Chromium.
No real user DB, user uploads, production S3 or production PostgreSQL was touched.

| Check | Actual result |
| --- | --- |
| New backend behavior | 6 tests passed; covers scoped uniqueness/permissions, atomic batches, filter pagination, private saved rules/reopen, duplicates, migration rollback/idempotency and database snapshot retention |
| Targeted backend, including existing safety/dedup/organization/scale/reference/restore regressions | **8 files / 56 passed**, no skipped tests |
| Targeted frontend | **10 suites / 51 passed**, including new editor failure/scope/batch tests, local-day boundaries, relative filters, Native refusal and retained recent browsing |
| Backend TypeScript and production bundle | Passed |
| Frontend TypeScript and production build | Passed; existing chunk-size warnings remain |
| Changed explorer/editor/filter components and helper ESLint | Passed |
| Whole frontend lint baseline | Same two existing failures in `fn-connect-startup.spec.ts:29` and `taskOfflineApi.test.ts:95`; neither changed |
| DCC mapping | **12 invariants / 137 references / 14 backend files / 25 frontend files** |
| Full backend DCC in fresh system-temp DB | **219 passed / 0 failed / 0 skipped** |
| Full frontend DCC | **220 passed / 3 existing schema v9/v10 assertion failures / 0 skipped** |
| PostgreSQL storage migration | Executed twice on an independent PGlite PostgreSQL/WASM instance: scoped uniqueness, relation guards, transfer cleanup, saved filter storage and tag deletion retention passed |
| Real application browser | **2 tests passed**: all B scenarios plus Phase C scenarios below |
| Bundle budget gate | Still fails the pre-existing initial-entry limits; final measured entry about 2.37 MiB raw / 679.7 KiB gzip, limits 2,000,000 / 650,000 bytes |

The PostgreSQL/WASM check executes actual PostgreSQL SQL/PLpgSQL, but does **not** prove the application's
PostgreSQL runtime, a separate PostgreSQL service, production migration orchestration or S3 behavior.
Its optional runtime was installed only in a temporary directory; no application dependency was added.
See [PGlite documentation](https://pglite.dev/docs/) and the checked-in `backend/scripts/verify-asset-organization-postgres.mjs`.

The backend DCC launcher does not assign a fresh DB to every local rerun. An early rerun encountered
an old fixed workspace fixture. Injecting per-process test setup also changes the DB identity of a
restart test, so the successful final run used one explicit, fresh system-temp DB instead. On macOS,
use `os.tmpdir()` rather than hardcoding `/tmp`, which the existing test safety guard rejects.
No unrelated runner, schema assertion or lint-debt repair is included.

## Real browser acceptance

The fixture has 103 initial records and 102 physical attachment objects: one extra record represents
an explicitly seeded legacy duplicate sharing an existing object. Its ID uses the real UUID format.
The existing B suite retains its real 100 uploads, expected 415 negative case, progress, stable move
and viewport/theme checks; only its expected initial row count was adjusted.

The new Phase C suite uses real HTTP routes and the production UI to:

1. Create a tag through file details and verify it is persisted.
2. Upload two actual text fixtures, select them and add the tag as a batch; verify both through the API.
3. Select the sidebar tag and intersect it with PNG format.
4. Save the filters, reload the page and reopen the smart folder with the correct one-file result.
5. Compare the original attachment ID, folder, URL and exact downloaded bytes before/after organization.
6. Filter identical files and show the authorized legacy sibling in details.
7. Verify dark mode, 390×844 layout without horizontal overflow, and English smart-folder controls.

Screenshots are actual runtime captures, not mocks:

- [Details and tag editor](screenshots/phase-c/detail-tags.png)
- [Batch tag panel](screenshots/phase-c/batch-tags.png)
- [Saved smart folder](screenshots/phase-c/smart-folder.png)
- [Identical-file details](screenshots/phase-c/identical-files.png)
- [Dark filters](screenshots/phase-c/dark-filters.png)
- [Mobile filters](screenshots/phase-c/mobile-filters.png)
- [English smart folder](screenshots/phase-c/english-smart-folder.png)

Original A/B screenshot evidence was preserved; their rerun captures were not included in this change.

## Reproduction

```sh
# backend: dependencies must match the running Node ABI
cd backend
npm run build:tsc -- --pretty false
npm run build
cd ..
node scripts/data-consistency-contract.mjs --verify

# Fresh DB for a repeatable full backend DCC run, preserving restart identity.
task_dcc_dir=$(node -e 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path");process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(),"nowen-assets-c-dcc-")))')
DB_PATH="$task_dcc_dir/test.db" ELECTRON_USER_DATA="$task_dcc_dir" NODE_ENV=test node scripts/data-consistency-contract.mjs --backend
node scripts/data-consistency-contract.mjs --frontend

cd frontend
npm run test:run -- src/components/fileExplorer/__tests__ src/hooks/__tests__/useFileUploadQueue.test.tsx src/i18n/__tests__/releaseI18nCoverage.test.ts src/lib/__tests__/assetFilters.test.ts src/lib/__tests__/fileExplorerModel.test.ts src/lib/__tests__/fileUploadProgress.test.ts src/lib/__tests__/mobileFileScope.test.ts src/lib/__tests__/mobileLocalAttachmentFolderBridge.test.ts src/lib/__tests__/voiceMemoLocalFirst.test.tsx
npm run build
npx playwright test --config playwright.files-assets.config.ts
npm run lint:baseline
```

Targeted backend suites were executed serially with the existing `runTestFile` helper.
For optional PostgreSQL/WASM acceptance, install `@electric-sql/pglite` outside the checkout and run
`node backend/scripts/verify-asset-organization-postgres.mjs /absolute/path/to/pglite/dist/index.js`.
No missing runtime or skipped test is counted as a pass.

## Compatibility, upgrade and rollback

Create and verify a full backup before deployment. Migration v127 adds only metadata and leaves
old attachment IDs, bytes, folders and note references intact. Database/full ZIP snapshots contain
the new tables automatically; note-only exports do not claim to export file-center organization.
An interrupted migration rolls back; repeated execution preserves existing rows. SQLite and
PostgreSQL relation constraints were independently exercised.

Older binaries that know only schema v126 reject the upgraded DB. Rollback therefore requires the
pre-upgrade database/attachment backup, not merely an older application image. Do not delete schema
history or drop real metadata tables as an automatic rollback strategy.

The updated frontend requires the matching backend for organization endpoints and filters. C is
ready for review, not release approval. Real Android, installed Electron, production S3/PostgreSQL,
WAN/offline reconnect, multi-device metadata sync and installation/upgrade acceptance remain unverified.
Phase D insertion/recycle-bin/full folder sync and Phase E AI remain out of scope.
