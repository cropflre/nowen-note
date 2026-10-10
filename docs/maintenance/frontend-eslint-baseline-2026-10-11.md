# Frontend ESLint baseline audit — 2026-10-11

## Why this snapshot changed

The original `frontend/eslint-baseline.json` came from commit `fd17d980ff3c206c53d114594a84cd8c559d050a`.
On the pristine `release/v1.5.2` code at commit `040c4289567d1bb120253677ab8ae0466694b63e`, the original exact-fingerprint checker reported **1,319 existing matches and 132 unrecognized diagnostics**. This was independently visible on #823 and #824 and blocked unrelated features (#821, #823, #824). The audit used CI run [38087050293](https://github.com/cropflre/nowen-note/actions/runs/38087050293), before any business source changes in this branch.

### Exact fingerprint changes

- Removed **76 obsolete diagnostic occurrences** across **59 distinct fingerprints**. Unused allowances were deleted, so fixed errors are no longer permitted to return.
- Admitted **132 diagnostics already present in the release branch** across **103 unique fingerprints**. Counts are exact; the baseline is not a rule/filename allowlist.
- Resulting current baseline: **1451 occurrences**, versus **1395 occurrences** previously recorded (including obsolete entries).
- No ESLint rule, severity, `compare()` behavior, or failure condition was relaxed. New diagnostic or extra occurrence still fails CI, even on the same line.

### Existing debt by ESLint rule

| Rule | Existing release diagnostics newly recorded |
| --- | ---: |
| `@typescript-eslint/no-explicit-any` | 122 |
| `@typescript-eslint/no-unused-vars` | 9 |
| `no-empty` | 1 |

### Largest existing debt concentrations

| Source file | Count |
| --- | ---: |
| `src/components/extensions/ColumnsExtension.ts` | 40 |
| `src/components/dataManagement/BackupCenter.tsx` | 11 |
| `src/lib/__tests__/blockCopyPaste.test.ts` | 9 |
| `src/lib/__tests__/repairRoundTripCustomNodes.test.ts` | 8 |
| `src/lib/__tests__/calloutExtension.test.ts` | 6 |
| `src/lib/__tests__/mobileSyncSwitch.test.ts` | 6 |

**Follow-up**: replace historical `any` types with precise editor/ProseMirror and test-mock types in separate commits. Never refresh this baseline from a feature branch: #821 had extra test errors not present on the reference release branch, which must be fixed in that PR instead.

## Reproduce

```bash
cd frontend
npm ci
npm run lint:baseline -- --emit-delta
```

A successful run prints `LINT_BASELINE_DELTA {"add":{},"remove":{}}`. Diagnostic deltas from later feature branches remain actionable CI failures, not automatically accepted.
