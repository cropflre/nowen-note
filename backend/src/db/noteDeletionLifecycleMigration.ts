import type { Migration } from "./migrations.impl";
import { installSyncOutboxCaptureTriggers } from "./syncOutboxCaptureMigration";
export const noteDeletionLifecycleMigration: Migration = {
  version: 131,
  name: "sync-note-deletion-lifecycle",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS sync_note_deletion_cleanup (
      mutationId TEXT PRIMARY KEY, noteId TEXT NOT NULL, attachments TEXT NOT NULL
    )`);
    // Historical clients may have queued a terminal delete without its body. Preserve
    // the last *existing* upsert before acknowledging it; never invent a trash intent.
    db.exec(`UPDATE sync_outbox AS deletion SET payload=json_set(
      json_patch((SELECT prior.payload FROM sync_outbox prior
        WHERE prior.profileId=deletion.profileId AND prior.scopeKey=deletion.scopeKey
          AND prior.entityType='note' AND prior.entityId=deletion.entityId AND prior.operation='upsert'
          AND prior.rowid<deletion.rowid AND json_valid(prior.payload) ORDER BY prior.rowid DESC LIMIT 1),
        CASE WHEN json_valid(deletion.payload) THEN deletion.payload ELSE '{}' END),
      '$._deletionRecovery',json_object('note',json((SELECT prior.payload FROM sync_outbox prior
        WHERE prior.profileId=deletion.profileId AND prior.scopeKey=deletion.scopeKey
          AND prior.entityType='note' AND prior.entityId=deletion.entityId AND prior.operation='upsert'
          AND prior.rowid<deletion.rowid AND json_valid(prior.payload) ORDER BY prior.rowid DESC LIMIT 1)),
        'attachments',json((SELECT json_group_array(json_object('id',prior.entityId,'path',json_extract(prior.payload,'$.path')))
          FROM sync_outbox prior WHERE prior.profileId=deletion.profileId AND prior.scopeKey=deletion.scopeKey
            AND prior.entityType='attachment' AND prior.operation='upsert' AND json_valid(prior.payload)
            AND json_extract(prior.payload,'$.noteId')=deletion.entityId))))
      WHERE deletion.entityType='note' AND deletion.operation='delete'
        AND json_extract(CASE WHEN json_valid(deletion.payload) THEN deletion.payload ELSE '{}' END,'$._deletionRecovery') IS NULL
        AND EXISTS(SELECT 1 FROM sync_outbox prior WHERE prior.profileId=deletion.profileId
          AND prior.scopeKey=deletion.scopeKey AND prior.entityType='note' AND prior.entityId=deletion.entityId
          AND prior.operation='upsert' AND prior.rowid<deletion.rowid AND json_valid(prior.payload))`);
    installSyncOutboxCaptureTriggers(db);
  },
};
