# Nowen Studio P1 — AI App Builder + version history

> Experimental stacked PR. Base P0 is PR #873; P1 is PR #874. Neither has shipped.

## Everyday user journey
1. Apps > Create your own app > AI App Builder. Describe the app in Chinese or English.
2. AI returns a strict AppSpec blueprint with a name, description, list/board layout and up to 8 typed fields. Review the proposal in the UI.
3. Select Use this draft, edit visually if desired, and only then Save app. The AI preview itself never changes the database.
4. On an existing app, choose Edit app > Edit with AI. Ask to rename fields, add fields, or change layout. The proposal preserves all existing field IDs/types and all existing record values.
5. Open Version history in the editor and explicitly confirm Restore version. A restoration commits a NEW revision, so it can itself be undone by restoring an earlier snapshot.

## Model and data isolation
- Reuses the authenticated user's existing Nowen AI provider settings and outbound fetch policy. No separate keys are stored.
- Only the user's instruction and the app's name/description/layout/field definitions are sent to the configured AI provider. No items or record values, no note/task content, secrets, JWT, or workspace identifiers.
- AI is NOT a code generation engine for this release: only strict server-side Zod-validated JSON AppSpec v1 is accepted. Rejects unknown properties, executable payloads, duplicate field IDs, invalid types, missing or retyped old fields, and oversized results.
- Upstream AI text is never rendered as HTML. Only the validated schema is rendered through React controls.
- One concurrent request per user, six requests per minute, max 1200 characters per prompt, 25-second timeout and bounded response size.
- If AI is disabled or no compatible model is configured, the feature returns an explicit error and suggests using manual templates; it does not pretend to generate with AI.
- Failure responses hide raw upstream errors so private provider configuration is not disclosed.

## Durable history and concurrency
- SQLite migration v134 creates personal_studio_app_versions, backfills P0 current revisions, and records save snapshots atomically through triggers.
- Retains the newest 25 snapshots per application. Each history endpoint is constrained by authenticated user ownership.
- POST /api/plugins/personal-apps/:appId/restore requires both target revision and expected current revision; stale requests return 409 and never overwrite concurrent changes.
- Restoring a snapshot restores its fields AND record values. UI warns before restoring and does not mutate anything without the user's confirmation.

## Explicitly not in scope
- Sync V2 offline data transport, external application publishing/sharing, free-form AI code execution, external API connectors, auto-install or implicit access to notes/tasks.
- Real provider contract tests require configured provider credentials. Playwright mocks only the AI preview response; save, history, and rollback exercise the actual production API.
- DB v134 requires an upgrade backup. Returning to an old version of Nowen requires restoration from a compatible backup.

## CI and acceptance
- Backend: node --import tsx --import ./tests/setup-db-isolation.ts --test tests/personal-studio-ai.test.ts
- Frontend: the Extension Platform V3 workflow runs 11 frontend/i18n suites and a production Vite build.
- Browser: Playwright installation/isolated app contracts; AI draft apply, server-side save and rollback, data survives reloading.
- Additional release acceptance: test against a configured real AI provider, account/workspace switching, Electron/NAS, database backup restore and server rollback.
