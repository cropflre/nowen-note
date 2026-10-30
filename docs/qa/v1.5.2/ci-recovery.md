# release/v1.5.2 CI recovery

Date: 2026-10-15 (Asia/Shanghai). Branch: `codex/release-1-5-2-ci-recovery`.
Base: `426bd193481b605ebe4a93ae03670b5c87fed0fa`.
Scope: repair existing CI failures only. Phase E, product behavior, database migrations and Sync V2 are unchanged.

## Confirmed causes

The original [PR #854 checks](https://github.com/cropflre/nowen-note/pull/854/checks) on `35ffb9dc`
contained six failing workflows. The same failures were reproduced on the current base before repairs.
Data Consistency Contract and Encrypted Notes CI on that original commit ultimately passed.

| Workflow | Evidence / cause | Repair |
| --- | --- | --- |
| File Public Origin | [Backend job](https://github.com/cropflre/nowen-note/actions/runs/38739914548/job/116438594617): `file-public-origin-runtime` imports a DB-backed module without temporary DB setup; guard refuses the development path | Add the existing isolation preloader |
| Backup Timezone | [Backend job](https://github.com/cropflre/nowen-note/actions/runs/38739914967/job/116438595961): `auto-full-backup` has the same import-time dependency | Preload isolation before both backup suites |
| Backup Restore Integrity | [Backend job](https://github.com/cropflre/nowen-note/actions/runs/38739914892/job/116438595156): storage classification imports a DB-backed service; guard rejects it | Isolate all five targeted backend commands |
| I18n Release | [Job](https://github.com/cropflre/nowen-note/actions/runs/38739914921/job/116438594935): the test duplicated runtime dictionary merging and omitted D4 `assetTools` | Check the actual runtime resource bundles; retain complete parity, interpolation and literal-key assertions |
| Issue 355 Content Format | [Frontend job](https://github.com/cropflre/nowen-note/actions/runs/38739914876/job/116438595959): a whole-module `react-i18next` mock omitted `initReactI18next` | Preserve actual module exports while stubbing only `useTranslation` |
| Issue 612 Data Protection | [Backend](https://github.com/cropflre/nowen-note/actions/runs/38739914458/job/116438594507) has an unisolated repository import; [frontend](https://github.com/cropflre/nowen-note/actions/runs/38739914458/job/116438594661) expects old HTML-preview source strings and reports two lint deltas | Use the preloader; execute actual preview-gate expressions and cover plaintext exclusion; type the boot diagnostic and the recurrence mock |
| Frontend Loading Performance | [Follow-up job](https://github.com/cropflre/nowen-note/actions/runs/38741906637/job/116445479242) reaches the existing bundle budget and finds the entry at 2.39 MiB raw / 686.5 KiB gzip; the full Tiptap emoji catalog is bundled into it | Give the existing emoji dependency its own vendor chunk; retain all budget thresholds and application loading behavior |
| Editor Runtime | [Follow-up job](https://github.com/cropflre/nowen-note/actions/runs/38743457239/job/116450812427), newly triggered by the Vite change, has the same incomplete `react-i18next` mock in the main `MarkdownPreview` suite | Preserve the real exports and replace only `useTranslation`, as in the Issue 494 suite |
| Attachment Markdown Math | [Follow-up job](https://github.com/cropflre/nowen-note/actions/runs/38744099495/job/116453064716), triggered by the preview test change, exposes the same missing export in the attachment math suite | Preserve the real i18n exports while retaining the translation stub and all math/PDF assertions |

The database guard is deliberately retained. Before-case commands for all four import-time failures
exit with the isolation refusal, before opening the repository DB. All subsequent backend verification
uses `--import tsx --import ./tests/setup-db-isolation.ts --test`, with Electron Node ABI 130 in this checkout.

The preview test extracts the actual initializer/switch/render expressions with the existing TypeScript parser;
it runs them with the real content-format detector. It verifies initial HTML, switching to HTML, an already
initialized note, and plaintext containing HTML even while the previous preview state remains true.
It no longer requires an exact historical expression string. Product editor source is unchanged.

The follow-up bundle failure was reproduced locally after the original six workflows passed on `6ee1a42e`.
With the emoji vendor chunk, the entry measures 1,964,789 raw / 623,319 gzip bytes, below the unchanged
2,000,000 / 650,000-byte individual limits. The initial dependency graph has six requests and totals
3,570,264 raw / 1,025,985 gzip bytes, within the unchanged total limits. This is a chunk-size repair;
it does not claim to defer emoji loading or materially reduce the first-screen download total.

## Local verification

| Check | Result |
| --- | --- |
| Four formerly unsafe direct backend invocations | Four guard refusals reproduced, no development DB bypass |
| Targeted backend suites for the failed jobs | 15 files / 83 passed, no failures |
| Frontend suites referenced by the six failed workflows | 25 files / 183 passed, no failures |
| Task offline/recurrence mock regression | 11 passed |
| Lint baseline gate unit tests | 4 passed |
| Frontend lint baseline | 1444 recorded historical errors / **0 new errors**; baseline file unchanged |
| Frontend TypeScript and production build | Passed; pre-existing Vite chunk-size warnings remain |
| Production web build and unchanged bundle budgets after emoji chunk split | Passed; gzip/Brotli assets generated |
| Startup, WebKit compatibility, auth, paste and rich-text safety suites after chunk split | 8 files / 58 passed |
| FN Connect slow/failed module startup against the production preview | 2 passed in local Edge Chromium; WebKit runs in Linux CI |
| Editor Runtime focused selection after fixing its mock | 29 files / 156 passed; the previous missing-export failure reproduced locally |
| Attachment math / shared Markdown / PDF selection after fixing its mock | 3 files / 17 passed; the previous missing-export failure reproduced locally |
| Backend `build:tsc` | Passed |
| DCC mapping | 12 invariants / 153 references verified |
| `git diff --check` | Passed |

Representative commands:

```text
backend: node --import tsx --import ./tests/setup-db-isolation.ts --test tests/file-public-origin-runtime.test.ts
backend: node --import tsx --import ./tests/setup-db-isolation.ts --test tests/backup-schedule.test.ts tests/auto-full-backup.test.ts
frontend: npx vitest run src/i18n/__tests__/releaseI18nCoverage.test.ts src/components/__tests__/MarkdownPreview.issue494.test.tsx src/components/__tests__/EditorPaneNativeMarkdownCollab.test.ts
frontend: npx vitest run src/lib/__tests__/taskOfflineApi.test.ts
frontend: npm run lint:baseline
frontend: npm run build
frontend: npm run build:web
frontend: npm run verify:bundle
backend: npm run build:tsc -- --pretty false
root: node --test scripts/tests/frontend-lint-baseline.test.cjs
root: node scripts/data-consistency-contract.mjs --verify
```

The same 15 backend suites include public origin, backup schedule/retention/integrity/large archives/corrupt rollback/
streaming, Yjs durability, repository adapters, migrations and attachment cache/reference/share/signature contracts.
The same 25 frontend suites include the complete i18n, content-format and data-protection job selections;
CI's filtered Issue 494 commands are covered by running both tests in that file.

## Delivery boundary

Local results are not a substitute for the new PR's Linux CI. Final remote status is recorded in the PR against
its exact head SHA. The full 1444-item historical lint baseline is not claimed to be fixed; its existing gate is
passing with zero new diagnostics. No release, automatic merge, installed-app, device or production-storage
acceptance is performed by this repair. Phase E remains separate at the user's request.
