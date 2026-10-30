# A01 Sync V2 note deletion lifecycle

Initial remote: e249719c. The shared release branch was externally advanced to 585ee251 and then bafe6a47 during work; the isolated fix was rebased and final validation was repeated on bafe6a47 in codex/v152-blockers-batch1. No merge or push was performed by this task. DCC-002/003/004/007/008/012. This is a source/local-regression fix, not release acceptance.

## Root cause and behavior

Sync note/delete directly deleted a scoped note, allowing an active note, missing version, locked note or a collaborator with delete but without manage rights to bypass the HTTP recycle-bin contract. Desktop coalescing also folded the explicit trash write into terminal deletion; Native physically removed the row before ACK without retaining its body.

HTTP and Sync now share a tombstone Knowledge ACL/lifecycle guard. Workspace route authorization resolves tombstone ACLs explicitly, so an authorized owner can actually reach the lifecycle guard without allowing collaborators through it. Sync requires a matching baseVersion, rejects active/locked notes and retained attachment-trash contents, and refuses cross-scope IDs. Already absent entities remain idempotent; the committed mutation ledger makes lost-ACK retries duplicate, without recreating rows. Knowledge-tree deletion follows the transactional business deletion.

The server advertises `noteDeletionLifecycle: trash-before-delete-v1`. Updated Desktop/Native clients preserve and acknowledge the explicit trash stage before a terminal delete. An unsupported server holds deletion with NOTE_DELETION_UPGRADE_REQUIRED and retains the original queue/body. No automatic soft-delete is fabricated for an old terminal request against an active remote note.

SQLite migration 131 installs recoverable deletion capture and a durable post-commit cleanup queue. Existing queued upsert bodies can enrich legacy terminal deletes without changing mutation IDs, order, retry counts, errors or status. A historical client that already discarded both its body and all earlier queued upserts cannot have those bytes reconstructed by an upgrade; active cloud data and the rejected intent remain protected for explicit reconciliation.

New Desktop/Native terminal mutations retain original bodies (including encrypted envelopes), attachment metadata and tree placement in `_deletionRecovery` until ACK. These local snapshots are stripped from terminal network payloads. Pending queues and conflict history protect recovery bytes from orphan cleanup, including while sync is disabled. Successful ACK allows unreferenced bytes to be reclaimed; shared paths remain intact. Server filesystem cleanup runs only after the mutation transaction commits; failures leave a durable retry job for a subsequent Push. This is not a secure-erasure guarantee.

A deletion conflict preserves both bodies and the deletion intent. Explicit keep-local requeues a versioned trash stage followed by terminal deletion; keep-remote restores the cloud version and forces authorized metadata refresh. Manual merge remains an explicit content choice, and encrypted manual merging remains prohibited. Conflict history retains the other version rather than silently discarding it.

## Failure-first evidence

New tests failed before the relevant implementation for active deletion, missing versions, weak permissions, coalescing, missing recovery, lost trash-stage ACK version and legacy enrichment. The explicit restore metadata refresh assertion also failed before its fix. A separate media/Security patch is documented in the A02/A14 files and committed independently.

## Validation

- 15 focused service/migration/permission/recovery tests, including encrypted envelope retention, shared file cleanup and transaction rollback.
- 34 Desktop engine cases, including older-server hold and missing trash-ACK-version retention.
- Four new real HTTP + independent Native SQLite scenarios: recovery across reopen; two-phase deletion + lost ACK/retry; conflict choices; older-server pause/resume with stable mutation ID. These four run directly with a test-name filter; network scenarios supply their own browser URL fixture.
- 38 broader Sync/tree/encryption/backup/trash/PAT file regressions and 52 affected frontend tests; final counts/logs are recorded in the delivery evidence.
- Frontend and backend TypeScript/production builds; DCC mapping check.
- A real v1.5.1 source archive creates schema 123 fixtures, which upgrade to schema 131. Account/preferences, parent-child tasks/reminder, four tree nodes, ordinary/rich/encrypted notes, history, attachment bytes and pending Outbox match. Restart, pre-upgrade backup restoration on both versions, integrity_check and foreign_key_check pass. Old code refuses the newer schema. Historical dependencies are shared with the candidate; this is not an installed-package upgrade test.

The existing broad Native test fixture lacks window.location. Its full-file diagnostic uses an external preload providing only a browser URL; no authentication/permission checks or assertions are bypassed. This batch does not fix A04, RC1, lint or other CI infrastructure. Do not equate that diagnostic with a green unmodified CI workflow.

Commands use the repository's runTestFile serial runner with setup-db-isolation for file regressions, and the ordinary Vitest/build scripts. Test output and reproducible external runners are preserved in the delivery artifact.

## Remaining acceptance

Physical Windows/Web/Android/iOS concurrent editing, process-kill at real device boundaries, signed installation/upgrade, remote object-storage failures, large historical databases and production rollout are not signed off. Existing legacy queues with no surviving body require explicit reconciliation, never queue clearing. Cross-scope legacy terminal operations against active remote resources now fail closed rather than deleting them implicitly. Conflict-history attachment bytes remain retained until that recovery history is explicitly retired. No main merge, push or Release is authorized by these results.
