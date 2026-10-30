# Phase E acceptance record

Date: 2026-10-15. Branch: `codex/files-assets-phase-e`.
Base: `6ba628f3`, the current release branch after the user merged CI repair PR #855.
Target: `release/v1.5.2`. PR [#856](https://github.com/cropflre/nowen-note/pull/856) was subsequently merged as `36da7ddf`; no release is implied.

## Delivered scope

| Requirement | Implementation |
| --- | --- |
| Classification suggestions | Read-only AI preview, existing personal destinations or new root folders; editable destination and per-file exclusion |
| Tag suggestions | Editable additive tags; reuse scoped normalized names and preserve existing relations |
| File descriptions | Editable metadata-derived descriptions, persisted only on confirmation and displayed in file details |
| Text metadata semantic retrieval | Existing Embedding settings and outbound transport; on-demand batches of at most 100 eligible files, cosine ordering and continuation |
| Optional image semantics | Not enabled; D4 visual comparison remains distinct from image embedding/OCR |
| Explicit execution | Strict structured schema, ownership/scope/protection rechecks, optimistic metadata fingerprint, one immediate transaction and persistent request idempotency |

## Safety design

- Preview performs no business or audit writes. Only selected authorized metadata and the user's own folder catalog go to the configured provider; no bytes, note content, note titles, storage paths or unrelated files.
- AI output cannot describe deletion, purge, arbitrary URLs, rename or ownership changes. Unknown fields, duplicate/unselected IDs, invalid targets and malformed model JSON are rejected.
- Sensitive notes and password-protected ancestors use the existing protection checks, including attachment references. ACL and metadata are checked again after asynchronous calls and before a confirmation/replay.
- Confirmation preserves attachment identity, bytes, paths and references. One transaction validates the complete selected batch, creates/reuses folders/tags, updates descriptions and stores the result. Any failure rolls back the complete batch and preserves existing Outbox work.
- Retry payloads are frozen after an uncertain result. The same request ID returns its stored result; altered payloads conflict. Identity changes discard stale UI results and abort model requests.
- Description deletion cascades from actual attachment deletion. Transferring an attachment across owners/spaces clears its old description to prevent leaks.
- Tags/descriptions are not added to the D3 synchronization protocol. Active desktop sync refuses AI organization before paid generation and at confirmation; Native bridge and transport explicitly refuse the new endpoints. Ordinary file management remains available.

## Verification

| Check | Evidence |
| --- | --- |
| Backend AI suite | 19 behavioral tests: consent, metadata privacy, ACL, protected folders, invalid output, stale drafts, full rollback, retry after DB reopen, sync refusal, workspace boundaries, semantic paging, invalid vectors, missing configuration and transfer isolation |
| Additional backend regressions | Existing asset organization/sync, Embedding configuration/worker, migration registry |
| Frontend feature/i18n/transport | 7 files / 50 passed, including no automatic write, editable subset, stable candidates, frozen retry, cancellation, identity changes, Native refusal and slow model request timeout |
| DCC mapping | 12 invariants / 159 references / 19 backend files / 26 frontend files |
| DCC frontend | 26 files / 233 passed |
| DCC backend | 19 isolated files / 272 passed after the protection and transfer changes |
| Types/build/budget | Frontend production build + gzip/Brotli and unchanged bundle budgets passed; backend TypeScript passed |
| Lint | Existing baseline remains 1444 historical diagnostics / zero new diagnostics |
| Real application browser | Production build + isolated SQLite + deterministic loopback model, Edge Chromium: consent, dry-run/no moves, edited destination/tags/description, subset confirmation, keyword search and 100+3 semantic paging passed |
| PostgreSQL storage migration | Executable isolated-schema test and PostgreSQL 16 CI service added; local PostgreSQL was not run |

Browser evidence: [mobile preview](./screenshots/phase-e/preview-mobile.png), [semantic search](./screenshots/phase-e/semantic-search.png).

Commands (backend on Electron Node ABI 130 in this checkout; always use the existing isolation preloader):

```text
backend: node --import tsx --import ./tests/setup-db-isolation.ts --test tests/asset-ai.test.ts
frontend: npm run test:run -- src/components/fileExplorer/__tests__ src/lib/__tests__/assetAITransport.test.ts src/i18n/__tests__/releaseI18nCoverage.test.ts
frontend: npm run build:web && npm run verify:bundle
root: node scripts/data-consistency-contract.mjs --verify
root: node scripts/data-consistency-contract.mjs --backend
root: node scripts/data-consistency-contract.mjs --frontend
frontend: NOWEN_FILES_AI_QA=1 npx playwright test --config playwright.files-assets.config.ts e2e/files-assets-ai.spec.ts
```

CI is authoritative for its exact head; final results and links are recorded in the PR. No real paid provider, model quality benchmark, installed Electron package, physical device, production object storage, physical disconnect or production PostgreSQL acceptance was performed.

Additional baseline probe: the legacy FileOrganization.test.tsx has 5 failing assertions and missing getServerUrl mock errors both on the unchanged pre-E CI branch and on this branch. Its flat move-selector expectations and incomplete old API mocks predate E. The other three probed suites passed (11 tests total across this probe). This is not counted as a passing full frontend suite or repaired by this feature.

## Follow-up, 2026-10-16

Branch: `codex/files-assets-phase-e-followup`, based on merged `36da7ddf`.

- The application already installs a `randomUUID` fallback in `androidCompat.ts`; the direct dialog call alone does not prove an HTTP LAN outage. The dialog now uses the existing `newLocalId` helper. A unit regression and the production-app browser flow remove `randomUUID` independently of the startup polyfill and verify preview, confirmation and semantic search.
- The original encrypted CI failed once and passed on one rerun. Investigation used a deterministic held REST response rather than weakening assertions. The browser fixture lacked production `EditorPane` ACK handling. After aligning that handling, the held response still reproduced lost input in the actual rich-text editor: deferred initialization left the synchronized note ID unset, so the first ACK was treated as a note switch. The sync effect now also runs when the editor instance becomes ready.
- The strengthened browser regression edits an encrypted region while an earlier successful response is held, releases that response, checks exact server ciphertext, reloads the note and decrypts the latest body. Existing plaintext-leak scans remain in place. The Markdown/rich-text conversion cases passed three repetitions (6 tests).
- Local validation: 51 file AI/UI/transport/i18n tests; 100 editor/save/conflict tests; all 41 encrypted browser tests; production-app AI browser flow with the ID fallback; frontend DCC 233; application and benchmark/browser TypeScript; production build, bundle budget and lint baseline (1444 historical / zero new diagnostics). Backend source, migrations and synchronization protocols are unchanged by this follow-up.
- Phase E CI on `36da7ddf` included actual PostgreSQL 16 storage migration (1 passed, zero skipped), backend AI and production-app browser jobs. The follow-up PR records its own exact-head CI separately. Installed applications, physical devices, paid model quality and production storage remain unverified.
- Follow-up CI initially reached the file navigation before the initial editor was ready and timed out waiting for selection controls. The AI browser flow now uses the same initial-editor readiness assertion as the other file-center flows; all three local repetitions passed. No sleep, retry loop or relaxed business assertion was added.
