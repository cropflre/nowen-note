import type Database from "better-sqlite3";

function readinessTableExists(db: Database.Database): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'sync_v2_tree_profile_readiness'
  `).get());
}

export function isKnowledgeTreeSyncReady(
  db: Database.Database,
  profileId: string,
): boolean {
  if (!readinessTableExists(db)) return false;
  const row = db.prepare(`
    SELECT status FROM sync_v2_tree_profile_readiness
    WHERE profileId = ?
  `).get(profileId) as { status?: string } | undefined;
  return row?.status === "ready";
}

/**
 * Called only after the negotiated tree Snapshot/reconcile has completed for this exact Profile.
 * Business Bootstrap readiness alone is deliberately insufficient.
 */
export function markKnowledgeTreeSyncReady(
  db: Database.Database,
  profileId: string,
): void {
  if (!readinessTableExists(db)) return;
  db.prepare(`
    INSERT INTO sync_v2_tree_profile_readiness (
      profileId, status, readyAt, updatedAt
    ) VALUES (?, 'ready', datetime('now'), datetime('now'))
    ON CONFLICT(profileId) DO UPDATE SET
      status = 'ready',
      readyAt = datetime('now'),
      updatedAt = datetime('now')
  `).run(profileId);
}

/** Re-lock one Profile whenever its baseline becomes untrustworthy. */
export function resetKnowledgeTreeSyncReadiness(
  db: Database.Database,
  profileId: string,
): void {
  if (!readinessTableExists(db)) return;
  db.prepare(`
    INSERT INTO sync_v2_tree_profile_readiness (
      profileId, status, readyAt, updatedAt
    ) VALUES (?, 'pending', NULL, datetime('now'))
    ON CONFLICT(profileId) DO UPDATE SET
      status = 'pending',
      readyAt = NULL,
      updatedAt = datetime('now')
  `).run(profileId);
}

/** Backup restore invalidates every remote relationship, not only the active Profile. */
export function resetAllKnowledgeTreeSyncReadiness(
  db: Database.Database,
): number {
  if (!readinessTableExists(db)) return 0;
  return db.prepare(`
    UPDATE sync_v2_tree_profile_readiness
    SET status = 'pending', readyAt = NULL, updatedAt = datetime('now')
    WHERE status <> 'pending' OR readyAt IS NOT NULL
  `).run().changes;
}
