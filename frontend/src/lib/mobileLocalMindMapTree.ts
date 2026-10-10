import type { NativeDatabase } from "./nativeDatabase";

const schemaReady = new WeakMap<NativeDatabase, Promise<void>>();

/** Device-only placement and trash state; never reuse the legacy mindmap_folders ID. */
export function ensureMobileLocalMindMapTree(db: NativeDatabase): Promise<void> {
  let pending = schemaReady.get(db);
  if (!pending) {
    pending = (async () => {
      await db.run(`CREATE TABLE IF NOT EXISTS mobile_local_mindmap_tree (
        mindmapId TEXT PRIMARY KEY,
        parentId TEXT,
        sortOrder INTEGER NOT NULL DEFAULT 0,
        isDeleted INTEGER NOT NULL DEFAULT 0 CHECK (isDeleted IN (0, 1))
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_mobile_local_mindmap_tree_parent
        ON mobile_local_mindmap_tree(parentId, sortOrder)`);
    })();
    schemaReady.set(db, pending);
    pending.catch(() => schemaReady.delete(db));
  }
  return pending;
}
