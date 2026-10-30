# Sync V2 reliability: implementation and acceptance

Third-batch evidence: [Native personal tree Pull](sync-v2-native-tree-pull-validation.en.md) adds negotiated structural reception, durable subscription recovery, committed REST notifications and root-document move repair. Native structural writes and conflict UI remain pending; the rest of this document retains the original first-batch record.

This branch improves the existing Sync V2 protocol; it does not replace it with another synchronization system. It is a **Draft candidate**, not completed production acceptance. Base: `release/v1.5.2` at `d95d3787`; branch: `codex/sync-v2-reliability`.

The [audit](sync-v2-reliability-audit.md) traces each platform's actual storage and synchronization path. The [validation record](sync-v2-reliability-validation.md) contains the complete entity/platform matrix, failure evidence, commands and limitations.

## Implemented fixes

- Native note writes read the latest version, save content and enqueue mutations in one transaction. Independent UI reads wait for Apply to finish instead of failing on a global transaction flag.
- Successful ACKs must identify a sent mutation and contain a valid server revision. Pending descendants rebase on ACK; old account responses are rejected after asynchronous JSON decoding. Restart retries the durable mutation before reconciling Snapshot.
- Remote deletion preserves unsent local content as a conflict. An update with an existing base cannot silently recreate a permanently deleted server note. Restoring that content uses a new identity.
- A native conflict choice/fork reads the latest durable local edit. Workspace Snapshot pruning protects unresolved conflicts, pending descendants and local attachment transfers; file removal follows actual metadata removal.
- Native runtime reuses `/ws` notices/reconnect to wake Pull. Foreground recovery and a 30-second foreground poll compensate for missing notices. UI refresh follows committed SQLite Apply. WebSocket carries notices, never authoritative note bodies.
- Desktop and Native fold multiple operations per identity in a Change Feed page before requesting current Snapshot payloads.

## Evidence

Final targeted runs: backend **272/272**, frontend **121/121**, consistency gate **12 invariants / 59 references**. Frontend/backend builds pass; lint baseline reports **0 new errors** with 1447 historical errors. No schema migration or dependency was added.

Remote checks at `6b4c5949`: Data Consistency, Android Local-first, Knowledge Tree and Data Protection CI pass. Docker CI builds the actual production image and runs the plugin smoke inside it successfully. Voice memo fixtures initially omitted successful ACK revisions; updating them to the real protocol yields 3/3 locally. The 16 missing encrypted-conversion translation keys also fail on base `d95d3787`, so that I18n failure is recorded as baseline debt. New commits require their own CI results.

The isolated Android API 35 emulator package used real Native SQLite. With the test HTTP endpoint unreachable, Markdown/rich-text creation was immediately readable. Force-stop/relaunch preserved identity, content and pending mutations; reconnection uploaded them and recorded ACKs. Actual WS/Pull, missed-notice polling and reconnect passed. The test package's crash buffer was empty during this run.

In an adb loopback environment, 30 samples per direction measured P50/P95/P99 of **337/348/768ms** for HTTP Push to Native Pull, and **375/394/429ms** for Native editing to server content plus persisted ACK. These are narrow integration measurements, not production WAN or full editor GUI latency. See the [machine report](test-results/sync-v2-android-2026-10-11.json).

## Remaining acceptance blockers

Second-batch evidence: [Native personal tree validation](sync-v2-native-tree-validation.md) adds atomic personal root/ordinary-folder Markdown and rich-text creation, durable hydration of authorized personal bodies, and actual Android API-bridge force-stop/recovery acceptance. The following paragraph records the first batch's original gaps; full native tree structure and mobile-browser Local-first remain incomplete.

Web/mobile browsers remain REST plus IndexedDB cache/offline queue, without unified transactional Local-first storage. Signed-in Android knowledge tree operations remain server-first; Native knowledge-tree V2 is missing. Issue #829's existing authorized remote fallback is not proof that tree-created notes are durably readable offline. Full EditorPane, tree creation, conflict UX, attachment bytes and revocation need device acceptance. Parent deletion with protected descendants, no-base stale IDs/tombstones, long-running WAN latency and crash reproduction need further tests. Docker full-sync/NAS and macOS/Linux/iOS/HarmonyOS package acceptance have not run.

Commits: audit `bd26fabe`, durability fixes `421d37eb`, native realtime/recovery `4588de41`. No main modification, force-push, merge or release was performed. The [Android harness](../scripts/android-sync-acceptance.mjs), test-only Vite configuration and loopback backend helper are excluded from normal production builds.
