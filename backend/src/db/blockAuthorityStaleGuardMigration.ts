import type { Migration } from "./migrations.impl.js";

/** 任何未同步 shadow 的旧写路径都会立刻把 Block 权威状态降级，读取端因此安全回退。 */
export const blockAuthorityStaleGuardMigration: Migration = {
  version: 57,
  name: "block-authority-stale-write-guard",
  up: (db) => {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_note_block_authority_stale_after_content_update
      AFTER UPDATE OF content ON notes
      WHEN OLD.content IS NOT NEW.content
      BEGIN
        UPDATE note_block_documents
        SET status = 'mismatch',
            mismatchReason = 'notes_content_changed_without_shadow_rebuild',
            updatedAt = datetime('now')
        WHERE noteId = NEW.id;
      END;
    `);
  },
};
