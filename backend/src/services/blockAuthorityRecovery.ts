import type Database from "better-sqlite3";
import { markBlockAuthorityMismatch, rebuildBlockAuthorityStore } from "../lib/blockAuthorityStore";
import { syncNoteBlocks } from "../lib/noteBlocks";

interface RecoveredNoteRow {
  id: string;
  content: string;
  contentFormat: string;
  version: number;
}

export interface BlockAuthorityRecoveryResult {
  synchronized: number;
  skipped: string[];
  failures: Array<{ noteId: string; error: string }>;
}

/**
 * 恢复或导入完成后逐笔记重建 Block 权威状态。
 * 单笔失败保留 notes.content，并标记已有 shadow 为 mismatch，不影响同批其他笔记。
 */
export function synchronizeRecoveredBlockAuthority(
  db: Database.Database,
  noteIds: Iterable<string>,
): BlockAuthorityRecoveryResult {
  const skipped: string[] = [];
  const failures: Array<{ noteId: string; error: string }> = [];
  let synchronized = 0;

  for (const noteId of new Set(noteIds)) {
    const note = db.prepare(`
      SELECT id, content, contentFormat, version FROM notes WHERE id = ?
    `).get(noteId) as RecoveredNoteRow | undefined;
    if (!note || !["tiptap-json", "markdown"].includes(note.contentFormat)) {
      skipped.push(noteId);
      continue;
    }

    try {
      db.transaction(() => {
        const synced = syncNoteBlocks(db, note.id, note.content, note.contentFormat);
        rebuildBlockAuthorityStore(db, note.id, synced.content, note.contentFormat, {
          noteVersion: note.version,
          operationType: "recovery-sync",
          operationJson: { source: "recovery" },
        });
      })();
      synchronized += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markBlockAuthorityMismatch(db, note.id, `recovery:${message}`);
      failures.push({ noteId: note.id, error: message });
    }
  }

  return { synchronized, skipped, failures };
}
