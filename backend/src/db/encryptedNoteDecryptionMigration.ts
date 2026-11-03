import type { Migration } from "./migrations.impl.js";
import { encryptedContentV2Migration } from "./encryptedContentV2Migration.js";

/** Only the owner conversion transaction can authorize an exact plaintext target. */
export const encryptedNoteDecryptionMigration: Migration = {
  version: 135,
  name: "encrypted-note-decryption-guards",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS encrypted_note_decryption_permits (
      noteId TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      sourceVersion INTEGER NOT NULL, sourceContent TEXT NOT NULL,
      content TEXT NOT NULL, contentFormat TEXT NOT NULL, contentText TEXT NOT NULL
    )`);
    // 从 v1.5.1 及更早版本升级时，encrypted_notes_update 仍是旧形态：其条件允许
    // "保持加密格式改内容" 通过。旧 runner 只比较 MAX(version)，v123 可能从未在该库上
    // 执行过，因此这里先按 v123 的权威 DDL 重建触发器（DROP IF EXISTS + CREATE，
    // 幂等），再在其上叠加解密许可，避免把安全缺口原样保留下来。
    encryptedContentV2Migration.up(db);
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='encrypted_notes_update'").get() as { sql: string };
    // 触发器 SQL 由 sqlite_master 原样保存，不同迁移写入的换行/空格各不相同，
    // 因此按容忍空白的正则定位，而不是字面量匹配。
    const triggerHead = /ON\s+notes\s+WHEN/i.exec(row?.sql ?? "");
    const raiseAt = /BEGIN\s+SELECT\s+RAISE/i.exec(row?.sql ?? "");
    if (!row?.sql || !triggerHead || !raiseAt || raiseAt.index <= triggerHead.index) throw new Error("ENCRYPTED_DECRYPTION_GUARD_MIGRATION_MISMATCH");
    const headEnd = triggerHead.index + triggerHead[0].length;
    const raiseStart = raiseAt.index;
    const permit = `NOT EXISTS (SELECT 1 FROM encrypted_note_decryption_permits p WHERE p.noteId IS OLD.id
      AND p.sourceVersion IS OLD.version AND p.sourceContent IS OLD.content
      AND p.content IS NEW.content AND p.contentFormat IS NEW.contentFormat AND p.contentText IS NEW.contentText
      AND OLD.contentFormat IN ('encrypted-note-v1','encrypted-note-v2') AND NEW.contentFormat IN ('markdown','tiptap-json')
      AND json_extract(OLD.content,'$.originalFormat') IS NEW.contentFormat
      AND NEW.version IS OLD.version + 1 AND NEW.id IS OLD.id AND NEW.userId IS OLD.userId
      AND NEW.notebookId IS OLD.notebookId AND NEW.workspaceId IS OLD.workspaceId
      AND OLD.workspaceId IS NULL AND OLD.isLocked = 0 AND OLD.isTrashed = 0)`;
    const rewritten = `${row.sql.slice(0, headEnd)} ${permit} AND (${row.sql.slice(headEnd, raiseStart)}) ${row.sql.slice(raiseStart)}`;
    db.exec(`DROP TRIGGER encrypted_notes_update; ${rewritten}`);
  },
};
