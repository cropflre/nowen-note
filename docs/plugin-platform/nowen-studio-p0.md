# Nowen Studio P0 — No-code Personal Apps

> Target: release/v1.5.3. Experimental Draft PR, not a published release.

## User flow
1. Open Apps and select Create your own app.
2. Choose Checklist, Personal records or Project tracker.
3. Edit name, description, text/checkbox fields and list/card layout.
4. Add example records in the live preview, then Save app.
5. Open it in My Apps, add records, toggle statuses and delete records, or edit its structure.

Ordinary users can create these apps without admin rights, npm, Manifest, signature or JavaScript.

## Technical and data boundaries
- SQLite migration v133 adds personal_studio_apps, userId, UUID, AppSpec JSON, revision and timestamps. Existing notes/tasks/plugin tables are not modified.
- Strict AppSpec schema v1 allows only text and checkbox fields and list/board layouts; no scripts, HTML, network, code or cross-app data access.
- Maximum 32 apps per user, 8 fields and 100 records per app; schema <= 48 KiB.
- Authenticated REST endpoints at /api/plugins/personal-apps and /api/plugins/personal-apps/:appId. Server auth supplies userId; API tokens are rejected. Every query restricts owner.
- Updates and deletes require expectedRevision; old revisions fail with HTTP 409 and never silently overwrite concurrent edits.
- Data lives on the current server, independently of V3 executable plugin registry. No Sync V2 offline outbox, cross-server sync, sharing or personal/workspace crossover in this phase.
- Changing authentication clears the UI and prevents late requests from restoring old account data.
- There is no AI Builder, source-code editor, community store or Nowen notes/tasks binding in P0.

## Upgrade safety
Back up the database before upgrade to schema v133. This project prevents older binaries that only know schema v132 from writing newer DBs. To downgrade, restore the pre-upgrade database backup, not merely the binary.

## Test commands
Backend: cd backend && node --import tsx --import ./tests/setup-db-isolation.ts --test tests/personal-studio-apps.test.ts
Frontend: cd frontend && npx vitest run src/lib/__tests__/personalApps.test.ts src/lib/__tests__/pluginApps.test.ts
Browser: cd frontend && npx playwright test --config playwright.plugin-apps.config.ts --reporter=line

GitHub Actions additionally exercises real template creation, saving, record creation and reload alongside the old V3 install/run loop. Passing tests do not replace Electron/Docker/NAS installation or schema restore acceptance.
