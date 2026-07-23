# Attachment reference PostgreSQL Runtime boundary

## Completed

- `attachmentReferencesRepository` async methods resolve the shared database Runtime Adapter.
- PostgreSQL inserts use `ON CONFLICT ("attachmentId", "noteId") DO NOTHING` while SQLite keeps `INSERT OR IGNORE`.
- `syncReferencesAsync()` shares attachment-reference diff semantics with the existing synchronous path.
- `syncAttachmentReferencesForNoteAsync()` updates `notes.contentText` and `attachment_references` without opening SQLite.
- Real PostgreSQL regression coverage verifies replacement, deletion, insertion, content-text rewriting, and idempotent replay.

## Deliberately retained boundary

`syncAttachmentReferencesForNote()` remains synchronous and SQLite-backed because it currently executes inside the larger `noteTransfer` atomic transaction. Removing that direct access independently would split the transaction and weaken rollback behavior.

The remaining synchronous exception is owned by #249 and must be removed together with the cross-driver `noteTransfer` transaction migration.
