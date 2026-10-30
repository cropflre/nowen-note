# Files & Assets Center — Phase A

Baseline: `release/v1.5.2`, `c8501ac6efba9539ed5e2831f7d97bd52cb482cc` (fetched 2026-10-14).
The initial working tree contained unrelated untracked task/native QA files; they were preserved.

## Source audit

| Classification | Findings |
| --- | --- |
| Implemented | Grid/list, pagination/search/sort, multi-select, upload/rename/batch-move, thumbnails, preview dispatcher, reverse reference index, SHA-256 dedup, local/S3 storage and signed/public sharing. Reuse these paths. |
| Partial | Folder `parentId` exists, but the existing UI groups folders flatly. Folder ownership is personal/user based; workspace file scopes cannot safely share these directories. Native device-only folders exist; signed-in Native folder synchronization is explicitly unavailable. |
| Missing for B | Explorer navigation/breadcrumbs, searchable tree picker, masonry, a controlled upload queue with network progress and cancellation. |
| Required repairs | Dedup silently changes location and promotes note attachments to independent assets; folder deletion leaves children behind; batch moves mix scopes; referenced/shared file deletion lacks protection; Native signed-in moves can call the server despite local authority. |

Relevant entry points: `FileManager`, `FileMoveDialog`, `FileUploadDialog`, `AttachmentDetailDrawer`,
`AttachmentPreview`, `api.impl`, `files`, `attachment-folders`, `attachments-core`,
`attachmentFoldersRepository`, migrations v33, `mobileLocalFirstBridge`,
`mobileLocalAttachmentFolderBridge`, `mobileLocalModuleBridge`.

## Implemented contract

- Duplicate upload keeps ID, location, creation time, storage key, note binding, references and original permission semantics. Missing bytes can still be repaired at the original local/S3 key. The response reports `deduplicated`, `folderId` and `folderName`.
- Personal folders accept only personal files. Workspace folder operations report `WORKSPACE_ATTACHMENT_FOLDER_UNSUPPORTED`; mixed-scope batches report `FILE_SCOPE_MISMATCH`. Legacy rows remain intact.
- Folder create/rename/move/delete checks run inside SQLite transactions. Moving into self/descendants, missing parents and same-level name collisions is rejected. Only empty directories can be deleted, including in Native device-only mode.
- Batch moves recheck authorization and scope inside the transaction. Optional `expectedFolderIds` prevents overwriting a stale location; old clients retain their existing request shape.
- Single/batch file deletion and attachment deletion check all indexed references, fallback content references, trashed notes and active file shares. No force-delete bypass is added. DB deletion precedes physical cleanup; objects shared by other attachment rows stay intact. Cleanup routes also retain protected records and their bytes.
- Reverse reference titles are filtered through note read permission. Authorization failures do not disclose note titles.
- Native signed-in folders and moves fail explicitly. Native signed-in permanent file deletion is blocked until the full remote-reference/lifecycle protocol exists; device-only deletion checks local note content. No Sync V2 entity or cursor/ACK protocol is changed.

## Validation

Windows, isolated temporary SQLite databases; backend native dependency uses Electron Node ABI 130.
No real user database was used.

- Initial baseline: organization, upload repair, folder repository, shared access, stable file sharing passed.
- New reproductions failed before the corresponding fixes: duplicate location, mixed scope and referenced deletion.
- Focused backend: 78 tests passed across safety (5), organization (10), upload repair (14), folder repository (11), shared access (7), stable sharing (5), manual upload retention (1), note deletion (13), orphan visibility (3), backup integrity (7), manual file visibility (2).
- Frontend Native folder bridge: 2 tests passed; TypeScript and production frontend build passed.
- Backend production bundle passed. DCC mapping: 12 invariants / 132 references verified.
- Full DCC backend behavior run: 13 files, 213 tests passed. Additional Native sync-switch tests are skipped without their configured native test runtime; they are not counted as passes.
- Targeted frontend lint reports 55 pre-existing `api.impl.ts` errors. Repository lint baseline reports 1445 historical errors and two pre-existing additions in `e2e/fn-connect-startup.spec.ts` and `taskOfflineApi.test.ts`; neither file was modified here. No lint cleanup is included.

Commands: `backend/scripts/run-tests-serial.mjs` `runTestFile` with `setup-db-isolation.ts`,
`npm run build` in backend/frontend, `npm run test:run -- src/lib/__tests__/mobileLocalAttachmentFolderBridge.test.ts`,
`npm run lint:baseline`, `node scripts/data-consistency-contract.mjs --verify`.

## Compatibility and acceptance limits

No migration, new storage layout, URL format, attachment ID or sync protocol. Existing databases and backups keep their schema.
Deletion intentionally returns 409 for referenced/shared files and nonempty folders; users must remove references/revoke shares/move children first.
Folder positions still do not synchronize through Sync V2; full synchronization and file recycle bin belong to separate Phase D PRs.
SQLite API tests and mocked S3 HTTP tests do not prove a PostgreSQL production deployment, real S3 service, Android device, installed Electron package, WAN operation or release readiness.
Tags/smart folders/AI and a true recycle bin are later phases and are not represented as implemented.

Phase A follow-up: read-only workspace uploads return 403 before creating a holder or attachment. Destination validation also precedes holder creation. The regression failed with 201 before the fix, then passed.
