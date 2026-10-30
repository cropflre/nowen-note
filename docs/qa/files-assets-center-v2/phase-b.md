# Files & Assets Center — Phase B

Implemented on `feat/files-assets-center-v2-ui`, based on Phase A commit `ec761c95` / PR #844.
Both PRs target `release/v1.5.2`; B depends on A and must be rebased after A is accepted.
Neither phase has been merged or released. Remote baseline was rechecked as `c8501ac6` on 2026-10-14.

## Delivered

- A collapsible file navigation sidebar replaces the note tree in this view. Default categories are all, recent seven days, images and documents; video/audio/archive/unorganized categories are expandable.
- Real nested folders, child folder creation, rename, folder movement, safe empty-folder deletion and clickable breadcrumbs. The move picker searches full paths, excludes a folder's descendants and retains optimistic position checks for file moves.
- One search/sort/view toolbar; grid defaults for all/images, list defaults for documents, remembered choices by account/server/workspace/category. Image masonry uses lazy thumbnails and intrinsic proportions with adjustable density, never prefetches original images for cards.
- The existing `AttachmentDetailDrawer` becomes an inline 340px panel on wide screens and a drawer on smaller screens. Its existing preview dispatcher, authorized reverse references, download, rename and sharing controls remain in use. Hashes/raw storage URLs are hidden in the normal view; external sharing is collapsed with explicit access semantics.
- Ctrl/Cmd and Shift selection, Enter/Space, Esc, context menus and file drag-to-folder. Internal drag payloads are distinct from operating-system files. Selection clears on page/filter changes, so hidden pages cannot be included in a destructive batch.
- Picker/drop/paste uploads use one three-request queue in the default explorer. XHR upload events provide real byte progress; auth renewal uses the existing session transport. Waiting jobs can be cancelled; browser/Electron requests can be aborted; failed jobs can be retried and completed records cleared. Active/failed/duplicate items sort before completed items. Duplicate responses show the original location and offer viewing or explicit moving.
- Native keeps the existing local persistence facade. It shows completion state without fabricated network percentages or cloud confirmation; cancellation of an already running Native save is unavailable. Signed-in folder writes/moves remain blocked. Device-only folder moves are transactional and reject cycles. Native file URL resolution now occurs after pagination.
- The existing Native facade is personal-only. Workspace reads/uploads/rename/delete fail before any personal SQL or repository write, preventing files from being silently stored in the wrong space.
- The original image-hosting/storage/unreferenced-file/settings view is retained under “Image hosting, storage & tools”. Its older upload dialog remains available there; the new explorer is the default browsing/upload flow.
- That legacy dialog distinguishes duplicates from newly protected uploads and reports their preserved location/permissions, rather than claiming that a reused note attachment became protected.
- New `fileKind` and `createdAfter` filters are validated once and applied consistently by the route and its permission/retention projections. No schema, object storage, attachment URL/ID or Sync V2 protocol changes.

## Actual acceptance

Windows 11, Edge Chromium headless, production frontend build and the full real backend;
validation ran across 2026-10-14–15 (Asia/Shanghai).
new temporary SQLite database, 102 actual on-disk attachments and three notes referencing one image.
No API mocks, real user database, user uploads or production deployment were used.

The browser test passed and exercised:

1. All-files pagination and a three-level folder path; creating a child through UI.
2. Grid/list/masonry, authorized note references and a searchable move dialog.
3. Moving an image while keeping the same ID, signed download address and exact PNG bytes.
4. Uploading 100 distinct files successfully; rejecting one deliberately prohibited MIME while continuing another valid upload.
5. Uploading duplicate bytes into another folder: reports existing/unorganized and leaves the original position unchanged.
6. A 1 MiB upload under CDP network throttling with real progress events.
7. 390×844 mobile viewport without horizontal page overflow, dark theme and English file-center labels.

Browser run: **1 test passed**, 15–16 seconds for the final scenarios (not a general performance SLA).
The logged HTTP 415 is the expected prohibited-file negative case, not an acceptance failure.

Additional results:

| Check | Result |
| --- | --- |
| Focused backend safety/scale/organization/dedup/orphan/shared-access | 43 passed |
| Focused frontend queue/progress/selection/Native folders/scope/back navigation | 13 passed |
| Production frontend/backend builds and frontend TypeScript | Passed; existing Vite bundle-size warnings remain |
| New components/helpers/picker/tests lint | Passed |
| Full frontend lint baseline | Failed on two unchanged existing files; no new lint errors from this phase |
| DCC mapping | 12 invariants / 132 references verified |
| DCC backend behavior | Phase A: 13 files / 213 passed |
| Full DCC frontend behavior, Node 24.19.0 with native SQLite | 24 files / 217 passed / 3 existing failures, no skipped tests |

Full DCC frontend failures are three assertions in
`frontend/src/lib/encryptedNotes/__tests__/nativeDatabaseInitialization.test.ts` expecting
`PRAGMA user_version = 9`, while the baseline `nativeDatabase.ts` already declares version 10.
Both files are byte-unchanged relative to `c8501ac6`; no migration or unrelated assertion repair is included.
The Windows `--frontend` launcher also fails with `spawnSync npx.cmd EINVAL`; its exact 24 referenced suites
were executed directly through Vitest with Node 24 instead. This is a launcher failure plus an independently reported suite result.
The two existing lint additions are `e2e/fn-connect-startup.spec.ts:29` and `taskOfflineApi.test.ts:95`.

## Metadata scale measurement

Temporary SQLite DB, Electron Node ABI 130, real wrapped `/api/files` route, 60 results/page.
Fixtures are metadata-only `.txt` records; there is no original-file or thumbnail I/O in this measurement.
“First” means the first query after inserting fixture rows; the SQLite data cache is already warmed by insertion.
It is **not** a cold-disk/cache benchmark. Repeated queries use the same process and database.

| Rows | First query | Repeated query | Filename search |
| --- | ---: | ---: | ---: |
| 100 | 8.6 ms | 3.0 ms | 1.5 ms |
| 1,000 | 7.1 ms | 5.5 ms | 1.4 ms |
| 10,000 | 30.2 ms | 28.1 ms | 4.0 ms |

These are one local run, not a production throughput or success-rate claim.

## Screenshots

Actual application with synthetic QA files (the colored images are explicitly marked fixture content):

- [All files](screenshots/all-files.png)
- [Folder navigation](screenshots/folder-navigation.png)
- [Image masonry](screenshots/image-masonry.png)
- [File details and three referenced notes](screenshots/file-details.png)
- [Move picker](screenshots/move-dialog.png)
- [Upload progress and expected rejection](screenshots/upload-progress.png)
- [Completed queue / duplicate feedback](screenshots/upload-queue-completed.png)
- [Mobile](screenshots/mobile-files.png)
- [Dark theme](screenshots/dark-files.png)
- [English](screenshots/english-files.png)

## Reproduction and remaining scope

Build with `npm run build` in frontend/backend. Run
`npx playwright test --config playwright.files-assets.config.ts` from frontend;
the checked-in QA launcher uses the repository Electron runtime and a new temporary DB on port 4197.
Run the focused Vitest suites and `backend/scripts/run-tests-serial.mjs`'s isolated `runTestFile`
for `files-assets-safety`, `files-assets-scale`, `file-manager-organization`,
`file-upload-dedup-repair`, `file-orphan-visibility`, `attachment-shared-access`.
For full Native frontend tests use Node >=22.13 with `node:sqlite` support.

Workspace folder organization and signed-in Native folder sync are intentionally unavailable.
Native workspace file-center operations are also explicitly unavailable, rather than falling back to personal data.
Real Android device/back-key behavior, installed Electron package, WAN/offline-reconnect,
real S3 deployment, PostgreSQL deployment and cold-cache UI performance are not tested here.
Existing server-side authorization/signatures remain authoritative; this is not a release approval.
New filter/folder-move UI requires the corresponding updated backend.
Phase C tags/smart folders, Phase D insertion/recycle-bin/sync, and Phase E AI are not delivered,
and no tag screenshot or fake recycle-bin/AI success is supplied.
