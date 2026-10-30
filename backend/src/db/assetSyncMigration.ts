import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

/** Keep historical IDs, queue order, retry state and conflict history intact. */
function widenEntityConstraints(db: Database.Database): void {
  const tables = ["sync_outbox", "sync_conflicts", "sync_changes_v2"];
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL")
    .all() as { name: string; sql: string }[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
  for (const table of tables) {
    const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string };
    if (sql.includes("'attachment_organization'")) continue;
    const highWater = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name=?").get(table) as {seq:number}|undefined)?.seq;
    const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
      .all(table) as { sql: string }[];
    const expanded = sql.replace(/'knowledge_tree_node'/g, "'knowledge_tree_node', 'attachment_organization'");
    if (expanded === sql) throw new Error(`Missing entity constraint: ${table}`);
    db.exec(expanded.replace(/CREATE TABLE\s+(?:"[^"]+"|\w+)/i, `CREATE TABLE ${table}_v129`));
    db.exec(`INSERT INTO ${table}_v129 SELECT * FROM ${table} ORDER BY rowid;
      DROP TABLE ${table}; ALTER TABLE ${table}_v129 RENAME TO ${table};`);
    if (highWater !== undefined) db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?").run(highWater,table);
    for (const index of indexes) db.exec(index.sql);
  }
  for (const trigger of triggers) db.exec(trigger.sql);
}

export const assetSyncMigration: Migration = {
  version: 129,
  name: "attachment-organization-sync",
  up(db) {
    widenEntityConstraints(db);
    db.exec(`CREATE TABLE IF NOT EXISTS asset_sync_metadata (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_asset_sync_user ON asset_sync_metadata(userId,id);
    CREATE TABLE IF NOT EXISTS asset_sync_bindings (
      profileId TEXT PRIMARY KEY REFERENCES sync_profiles(id) ON DELETE CASCADE,
      userId TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0
    );`);

    const folder = (a: string, deleted: boolean) => `json_object('id','folder:'||${a}.id,'kind','folder',
      'resourceId',${a}.id,'userId',${a}.userId,'name',${a}.name,'parentId',${a}.parentId,
      'deleted',${deleted ? 1 : 0},'createdAt',${a}.createdAt,'updatedAt',${a}.updatedAt)`;
    const file = (a: string, deleted: boolean) => `json_object('id','file:'||${a}.id,'kind','file',
      'resourceId',${a}.id,'userId',${a}.userId,'folderId',${a}.folderId,
      'trashedAt',${a}.trashedAt,'originalFolderId',${a}.originalFolderId,'deleted',${deleted ? 1 : 0})`;
    // Initial metadata is a baseline, never an implicit upload of old local data.
    db.exec(`INSERT OR IGNORE INTO asset_sync_metadata SELECT 'folder:'||f.id,f.userId,1,${folder("f", false)} FROM attachment_folders f;
      INSERT OR IGNORE INTO asset_sync_metadata SELECT 'file:'||a.id,a.userId,1,${file("a", false)}
      FROM attachments a WHERE a.workspaceId IS NULL;`);
    for (const [table, kind] of [["attachment_folders", "folder"], ["attachments", "file"]] as const) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
        const alias = operation === "DELETE" ? "OLD" : "NEW";
        const value = kind === "folder" ? folder(alias, operation === "DELETE") : file(alias, operation === "DELETE");
        const changed = operation !== "UPDATE" ? "1" : kind === "folder"
          ? "OLD.name IS NOT NEW.name OR OLD.parentId IS NOT NEW.parentId"
          : "OLD.folderId IS NOT NEW.folderId OR OLD.trashedAt IS NOT NEW.trashedAt";
        db.exec(`CREATE TRIGGER IF NOT EXISTS asset_sync_${kind}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
          WHEN (SELECT enabled FROM sync_v2_should_log)=1 ${kind === "file" ? `AND ${alias}.workspaceId IS NULL` : ""}
          AND (${changed}) BEGIN
          INSERT INTO asset_sync_metadata (id,userId,version,payload) VALUES ('${kind}:'||${alias}.id,${alias}.userId,1,${value})
          ON CONFLICT(id) DO UPDATE SET version=asset_sync_metadata.version+1,payload=excluded.payload;
        END;`);
      }
    }
    for (const operation of ["INSERT", "UPDATE"]) db.exec(`CREATE TRIGGER IF NOT EXISTS asset_sync_metadata_${operation.toLowerCase()}
      AFTER ${operation} ON asset_sync_metadata BEGIN
      INSERT INTO sync_changes_v2(entityType,entityId,userId,workspaceId,operation,version)
        SELECT 'attachment_organization',NEW.id,NEW.userId,NULL,'upsert',NEW.version
        WHERE (SELECT enabled FROM sync_v2_should_log)=1;
      INSERT INTO sync_outbox(id,mutationId,profileId,scopeKey,deviceId,entityType,entityId,operation,baseVersion,payload,status,retryCount,createdAt)
        SELECT lower(hex(randomblob(16))),lower(hex(randomblob(16))),target.profileId,'personal',
          (SELECT deviceId FROM sync_v2_local_device),'attachment_organization',NEW.id,'upsert',
          ${operation === "INSERT" ? 0 : "OLD.version"},json_set(NEW.payload,'$.version',NEW.version),'pending',0,datetime('now')
        FROM sync_v2_outbox_target target JOIN asset_sync_bindings b ON b.profileId=target.profileId
        WHERE b.ready=1 AND b.userId=NEW.userId AND (SELECT enabled FROM sync_v2_should_enqueue)=1;
    END;`);
  },
};
