# Nowen Studio P2 — Release safety and AI provider verification

> Experimental: Draft PR #876 stacked on #874 (AI Builder P1), which itself depends on #873 (no-code Studio P0). None is in a published release.

## What is now enforced
- AI preview requests are strictly validated: instruction must be a nonempty string <= 1200 chars; the optional spec must match AppSpec V1; unknown input properties and incorrect types fail closed with STUDIO_AI_INVALID_INPUT (400).
- Unexpected upstream exceptions, including errors with arbitrary `code` properties, are mapped to STUDIO_AI_PROVIDER_FAILED (502). The response must never include the endpoint, key, raw model error text, or user prompt.
- The normal preview path still never stores proposals; users explicitly accept a proposal and save it through the existing revision-checked personal-app API.
- `personal-studio-provider-contract.test.ts` spins up an actual HTTP OpenAI-compatible endpoint bound to 127.0.0.1 and exercises the real `callAIChat`/outbound fetch path. It checks authentication header, model name, strict schema, preservation of records and no record values in upstream requests, plus cross-account configuration isolation.
- `personal-studio-backup-restore.test.ts` verifies v133→v134 migration, SQLite WAL online backup, disk restoration after changes and deletes, user isolation, and reversible version recovery.

## Optional REAL external model smoke (manual)
Use the user's **own** configured test model and a disposable API key. The CLI never reads a Nowen user database and sends only a synthetic instruction to the provider.

From `backend/`:

```bash
STUDIO_AI_SMOKE_URL='https://YOUR_PROVIDER/v1' \
STUDIO_AI_SMOKE_PROVIDER='openai' \
STUDIO_AI_SMOKE_MODEL='YOUR_MODEL' \
STUDIO_AI_SMOKE_KEY='YOUR_TEST_KEY' \
node --import tsx scripts/studio-ai-live-smoke.ts
```

For local Ollama/LM Studio, set `STUDIO_AI_SMOKE_PROVIDER=ollama|lmstudio` and omit the key. This requires a reachable OpenAI-compatible `/chat/completions` endpoint, not just the provider's native API.

**Do not** paste live tokens into CI logs, issues or PRs. Prefer environment secrets. The probe does not print any raw provider response or credentials; it reports a pass/fail and exits nonzero on failure. Since live credentials and endpoints have not been provided to this PR, no claim of external model validation is made.

## CI
- V3 Foundation includes provider HTTP contract, migration/backup restore, P0/P1 regression and backend TypeScript, plus frontend release build and existing Playwright E2E.
- A successful CI run does **not** prove compatibility with every commercial model. Use the above opt-in probe with each intended provider, then do a manual click-through with that account's model settings.
- The standalone Sync V2 full data consistency suite has known failures also observed on the P0 baseline. Treat it as a separate release blocker, not a pass.

## Deployment and rollback checklist
1. Take a complete SQLite backup with the existing Nowen backup mechanism; verify that it opens and passes a database integrity check.
2. Upgrade to schema v134 in a staged copy, then verify `/api/plugins/personal-apps`, versions, AI preview and multi-user isolation.
3. Create an app and save a revision; restore an older revision; reload. Verify no cross-account content after login switch.
4. Re-run Web, Electron desktop and actual Docker/NAS environment acceptance; pay special attention to provider/network proxy differences.
5. To downgrade a database, restore a pre-upgrade backup. Older binaries do not support automatically downgrading v134.
6. Do not merge until full data consistency gate and security review are resolved, or an explicitly documented, scoped release exception is approved.
