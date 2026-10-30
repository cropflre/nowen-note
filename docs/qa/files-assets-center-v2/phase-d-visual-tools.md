# Files & Assets Center — Phase D4

Baseline: `release/v1.5.2` / `4891f3e780a5dbaf56bb86a19121ecf717ba2e4e`.
Branch: `codex/files-assets-center-v2-visual-tools`; tested 2026-10-15, Asia/Shanghai.
This phase is not merged or released. Phase E AI and release acceptance are not included.

## Delivered scope and reuse

- Similar-image search from image details/context menu: local difference-hash layout comparison plus an average-color guard. Distinct from the existing SHA-256 identical-file list. No accuracy percentage or semantic-search claim.
- Explicit 20-candidate batches with continue/retry, coverage/skip counts and cancellation. Current-space membership, per-file download permission and trash state are checked before reading bytes and checked again after asynchronous work. Hidden scopes do not contribute counts or matches.
- Existing attachment storage reads and signed thumbnail URLs are reused; no original URLs, IDs, note links, bytes or storage keys are changed. GIF compares only the first frame. Decode candidates are PNG/JPEG/WebP/GIF/BMP up to 20 MiB and 40 megapixels; corruption and unsupported decoding are reported as skips. At most two concurrent server scans and a three-second decoder limit per image bound active work; no index or background scan is introduced.
- Numbered batch rename with a before/after preview, preserved extensions and original-name comparison. All authorization/scope/lifecycle checks run in one database transaction. Existing attachment metadata triggers capture Outbox writes; a failure in a later item rolls back earlier names and queue entries.
- Existing file preview/details/download/move/tag surfaces remain in use. New dialogs use existing theme tokens, Chinese/English labels, keyboard focus containment, Escape and Native back handlers. Native rejects these operations before local SQL or server fallback.
- No schema migration, new storage copy, Sync V2 entity or cursor/ACK changes. SQLite source/API evidence only, not PostgreSQL parity or full lifecycle sync proof.

## Validation

| Check | Actual result |
| --- | --- |
| New backend visual/rename tests | 6 passed; initially missing endpoints reproduced as 404 |
| Backend visual + tags + folder organization + safety + existing-file note linking | 33 passed |
| Backend test isolation + Outbox capture | 16 passed |
| New frontend preview/dialog/Native fail-closed tests | 10 passed |
| Frontend production TypeScript/build | Passed; existing Vite size warnings remain |
| Backend TypeScript and production bundle | Passed |
| New/changed explorer components, helpers and browser test lint | Passed |
| Full lint baseline | 1444 baseline errors + two unchanged existing errors; no errors introduced by this phase |
| DCC mapping | 12 invariants / 153 references / 18 backend suites / 25 frontend suites |
| Full frontend DCC, actual fixed launcher with Node 24.19.0 | 25 files / 231 passed, no failures or skips |
| Full backend DCC, isolated launcher | 18 files / 253 passed, no failures or skips |
| Actual app browser test | 1 passed, real backend and production UI, no API mocks |

The browser test checks authorized matching, desktop and 390×844 dialogs, a rename preview, another tab renaming
between preview/confirm (expected HTTP 409), whole-batch rejection, refreshed preview and successful confirmation.
The original signed download URL still returns identical PNG bytes, ID is unchanged and all three note references remain.
Dark/English labels are exercised in the actual app. The last successful scenario took 2.7 seconds; this is not a performance SLA.
Backend pagination covers 46 candidates across three batches, including corruption and cross-scope exclusion; algorithm fixtures include resized bytes and a visibly unrelated color image.

The two existing lint deltas are `e2e/fn-connect-startup.spec.ts:29` (`no-explicit-any`) and
`src/lib/__tests__/taskOfflineApi.test.ts:95` (unused `_id`), byte-unchanged from the baseline.
The earlier Native schema initialization assertion failures do not reproduce on this baseline; the full current suite passes.

### Test-launcher correction

The original DCC backend command bypassed `setup-db-isolation.ts`; suites without their own DB path reached
the repository `backend/data/nowen-note.db` and one fixed workspace fixture failed uniqueness. That database
was snapshotted and the user confirmed it contains disposable test data; no recovery was requested or performed.
The developer-service root `data/nowen-note.db` is a separate path. This first unsafe run is not acceptance evidence.

The launcher now reuses `runTestFile`, including temporary DB setup, timeout and ESM handling. The guard also
recognizes Node's test-runner context when `NODE_ENV` is absent, so direct test invocation cannot open the development
database. A regression checks that refusal and permits temporary fixtures. Windows `spawnSync npx.cmd EINVAL`
is fixed by invoking Vitest through the current Node runtime. The original public `--frontend` command now passes.

## Real screenshots

Synthetic QA assets in an isolated real app; no static mockups:

- [Similar images](screenshots/phase-d-visual-tools/similar-images.png)
- [Similar images on a narrow viewport](screenshots/phase-d-visual-tools/similar-mobile.png)
- [Rename preview](screenshots/phase-d-visual-tools/batch-rename-preview.png)
- [Rename preview on a narrow viewport](screenshots/phase-d-visual-tools/batch-rename-mobile.png)
- [Concurrent-name conflict](screenshots/phase-d-visual-tools/batch-rename-conflict.png)
- [Dark theme and English](screenshots/phase-d-visual-tools/similar-dark-english.png)

## Reproduce and remaining limits

1. Build backend and frontend using `npm run build` in each directory.
2. From frontend, run `npx playwright test --config playwright.files-assets.config.ts files-assets-visual-tools.spec.ts`.
   If using installed Edge on Windows, set `NOWEN_QA_BROWSER_CHANNEL=msedge`. The QA launcher probes an in-memory SQLite
   connection and chooses the bundled Electron runtime only when the installed binding needs it; it never rebuilds dependencies.
3. Run `node scripts/data-consistency-contract.mjs --verify`, `--backend`, `--frontend` from root. Use the Node runtime matching
   backend SQLite ABI for backend tests, and Node >=22.13 with `node:sqlite` for full Native frontend suites.

Scans are approximate, manually paged, limited to supported downloadable active images in the current scope, and can miss
crops/rotations or match similar templates. There is no persistent index, production-library benchmark or AI.
Native visual tools remain unavailable; Native trash, tag/smart-folder sync and unsupported workspace folder operations retain
their previous boundaries. Installed Electron, actual mobile hardware, production S3/PostgreSQL and physical network loss
were not validated. This work does not constitute release approval or an exhaustive definition of all future “advanced organization”.
