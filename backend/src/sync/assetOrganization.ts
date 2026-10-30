import { setAttachmentExternalAccessEnabled } from "../services/attachment-link-policy";
import type Database from "better-sqlite3";
import { SyncError } from "./errors";
import { runChangeFeedSuppressed } from "./suppression";
import { runWithOutboxSuppressed } from "./context";
import type { ApplyMutationInput } from "./apply";
import { recordConflict } from "./conflict";
import { enqueueMutation } from "./outbox";

/** An older remote must not turn a successful local move into an unqueued write. */
export function assetOrganizationWriteAvailable(db: Database.Database,userId:string): boolean {
  const profile=db.prepare(`SELECT p.id,b.ready FROM sync_profiles p LEFT JOIN asset_sync_bindings b ON b.profileId=p.id AND b.userId=?
    WHERE p.enabled=1 AND (p.remoteUserId=? OR b.userId=?) ORDER BY p.updatedAt DESC LIMIT 1`)
    .get(userId,userId,userId) as {id:string;ready:number|null}|undefined;
  return !profile || profile.ready===1;
}

export function prepareAssetBaseline(db: Database.Database, entries: Record<string,unknown>[], profileId: string, deviceId: string, userId: string): void {
  const binding = db.prepare("SELECT ready FROM asset_sync_bindings WHERE profileId=? AND userId=?").get(profileId,userId) as {ready:number} | undefined;
  if (binding?.ready) return;
  const remote = new Map(entries.map(p => [String(p.id),p]));
  const rows = db.prepare("SELECT id FROM asset_sync_metadata WHERE userId=? ORDER BY rowid").all(userId) as {id:string}[];
  for (const {id} of rows) {
    const held=db.prepare(`SELECT 1 FROM sync_outbox WHERE profileId=? AND entityType='attachment_organization' AND entityId=?
      UNION ALL SELECT 1 FROM sync_conflicts WHERE profileId=? AND entityType='attachment_organization' AND entityId=? AND status='unresolved' LIMIT 1`)
      .get(profileId,id,profileId,id);
    if(held) continue;
    const local = readAssetMetadata(db,id,userId)!;
    // An untouched root assignment is not an organization intention.
    if (local.deleted || local.kind === "file" && !local.folderId) continue;
    const other = remote.get(id);
    if (other && sameAssetOrganization(local,other)) continue;
    if (other) recordConflict(db, {profileId,scopeKey:"personal",entityType:"attachment_organization",entityId:id,
      localPayload:local,remotePayload:other,remoteVersion:Number(other.version)});
    else enqueueMutation(db, {profileId,deviceId,scopeKey:"personal",entityType:"attachment_organization",entityId:id,
      operation:"upsert",baseVersion:0,payload:local});
  }
}

export function sameAssetOrganization(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return ["kind","resourceId","name","parentId","folderId","deleted","trashedAt"].every(key => (a[key] ?? null) === (b[key] ?? null));
}

export function readAssetMetadata(db: Database.Database, id: string, userId: string): Record<string, unknown> | null {
  const row = db.prepare("SELECT payload,version FROM asset_sync_metadata WHERE id=? AND userId=?")
    .get(id,userId) as { payload: string; version: number } | undefined;
  return row ? { ...JSON.parse(row.payload), version: row.version } : null;
}

export function assertAssetMetadata(id: string, p: Record<string, unknown>, userId: string): void {
  if ((p.kind !== "folder" && p.kind !== "file") || typeof p.resourceId !== "string" || !p.resourceId
    || p.id !== id || id !== `${p.kind}:${p.resourceId}` || p.userId !== userId
    || (p.deleted !== 0 && p.deleted !== 1) || !Number.isSafeInteger(p.version) || Number(p.version) < 1
    || (p.kind === "folder" && (typeof p.name !== "string" || !p.name.trim() || p.name.length > 100
      || !(p.parentId === null || typeof p.parentId === "string" && p.parentId && p.parentId !== p.resourceId)))
    || (p.kind === "file" && !(p.folderId === null || typeof p.folderId === "string" && p.folderId))) {
    throw new SyncError("INVALID_PAYLOAD", "附件整理元数据无效");
  }
}

/** Push accepts organization intentions, never attachment bytes, ownership or trash writes. */
export function applyAssetOrganization(db: Database.Database, input: ApplyMutationInput): number {
  const p = input.payload || {};
  if (input.workspaceId || input.operation !== "upsert") throw new SyncError("INVALID_PAYLOAD", "仅支持个人附件整理同步");
  assertAssetMetadata(input.entityId,p,input.userId);
  const foreign = db.prepare("SELECT userId FROM asset_sync_metadata WHERE id=?").get(input.entityId) as { userId: string } | undefined;
  if (foreign && foreign.userId !== input.userId) throw new SyncError("SCOPE_FORBIDDEN", "无权整理此附件或目录");
  const current = readAssetMetadata(db,input.entityId,input.userId);
  if (input.baseVersion !== (current?.version ?? 0) || current?.deleted === 1 && p.deleted !== 1) {
    throw new SyncError("VERSION_CONFLICT", "附件整理位置已更改，请选择保留的版本");
  }
  if (p.kind === "folder") {
    const folderId = String(p.resourceId);
    const existing = db.prepare("SELECT userId FROM attachment_folders WHERE id=?").get(folderId) as { userId: string } | undefined;
    if (existing && existing.userId !== input.userId) throw new SyncError("SCOPE_FORBIDDEN", "无权访问文件夹");
    if (p.deleted) {
      if (db.prepare("SELECT 1 FROM attachment_folders WHERE parentId=? UNION ALL SELECT 1 FROM attachments WHERE folderId=? LIMIT 1")
        .get(folderId,folderId)) throw new SyncError("VERSION_CONFLICT", "目录非空，不能删除");
      if (existing) db.prepare("DELETE FROM attachment_folders WHERE id=? AND userId=?").run(folderId,input.userId);
    } else {
      const seen = new Set([folderId]);
      let ancestor = p.parentId as string | null;
      while (ancestor) {
        if (seen.has(ancestor)) throw new SyncError("VERSION_CONFLICT", "目录移动形成循环");
        seen.add(ancestor);
        const parent = db.prepare("SELECT parentId FROM attachment_folders WHERE id=? AND userId=?")
          .get(ancestor,input.userId) as { parentId: string | null } | undefined;
        if (!parent) throw new SyncError(readAssetMetadata(db,`folder:${ancestor}`,input.userId)?.deleted === 1 ? "VERSION_CONFLICT" : "MISSING_DEPENDENCY", "父目录不存在或尚未同步");
        ancestor = parent.parentId;
      }
      if (db.prepare("SELECT 1 FROM attachment_folders WHERE userId=? AND name=? AND parentId IS ? AND id<>?")
        .get(input.userId,p.name,p.parentId,folderId)) throw new SyncError("VERSION_CONFLICT", "同级文件夹名称已被使用");
      db.prepare(`INSERT INTO attachment_folders(id,userId,name,parentId,createdAt,updatedAt) VALUES (?,?,?,?,datetime('now'),datetime('now'))
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,parentId=excluded.parentId,updatedAt=excluded.updatedAt`)
        .run(folderId,input.userId,p.name,p.parentId);
    }
  } else {
    const file = db.prepare("SELECT folderId,trashedAt FROM attachments WHERE id=? AND userId=? AND workspaceId IS NULL")
      .get(p.resourceId,input.userId) as { folderId: string | null; trashedAt: string | null } | undefined;
    if (!file) throw new SyncError("MISSING_DEPENDENCY", "附件元数据尚未同步");
    if (p.deleted || file.trashedAt || p.trashedAt) throw new SyncError("VERSION_CONFLICT", "回收站附件不可移动");
    if (p.folderId && !db.prepare("SELECT 1 FROM attachment_folders WHERE id=? AND userId=?").get(p.folderId,input.userId)) {
      throw new SyncError(readAssetMetadata(db,`folder:${p.folderId}`,input.userId)?.deleted === 1 ? "VERSION_CONFLICT" : "MISSING_DEPENDENCY", "目标目录不存在或尚未同步");
    }
    db.prepare("UPDATE attachments SET folderId=? WHERE id=?").run(p.folderId,p.resourceId);
  }
  // A no-op or create+delete must still advance once and leave a tombstone.
  const version = Number(current?.version ?? 0) + 1;
  const stored = readAssetMetadata(db,input.entityId,input.userId);
  const row = p.kind === "folder"
    ? db.prepare("SELECT name,parentId,createdAt,updatedAt FROM attachment_folders WHERE id=? AND userId=?").get(p.resourceId,input.userId) as Record<string,unknown>|undefined
    : db.prepare("SELECT folderId,trashedAt,originalFolderId FROM attachments WHERE id=? AND userId=? AND workspaceId IS NULL").get(p.resourceId,input.userId) as Record<string,unknown>|undefined;
  const canonical = {
    id:input.entityId,userId:input.userId,kind:p.kind,resourceId:p.resourceId,deleted:p.deleted,version,
    ...(p.kind === "folder" ? {name:row?.name??current?.name??p.name,parentId:row?row.parentId:current?.parentId??null,
      createdAt:row?.createdAt??current?.createdAt??new Date().toISOString(),updatedAt:row?.updatedAt??current?.updatedAt??new Date().toISOString()}
      : {folderId:row?.folderId??null,trashedAt:row?.trashedAt??null,originalFolderId:row?.originalFolderId??null}),
  };
  if (stored?.version !== version) db.prepare(`INSERT INTO asset_sync_metadata(id,userId,version,payload) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET version=excluded.version,payload=excluded.payload`)
    .run(input.entityId,input.userId,version,JSON.stringify(canonical));
  return version;
}

export function receiveAssetMetadata(db: Database.Database, entries: Record<string,unknown>[], profileId: string, userId: string): void {
  db.transaction(() => {
    const applicable: Record<string,unknown>[] = [];
    for (const p of entries) {
      assertAssetMetadata(String(p.id),p,userId);
      const local = readAssetMetadata(db,String(p.id),userId);
      const conflict = db.prepare(`SELECT id FROM sync_conflicts WHERE profileId=? AND scopeKey='personal'
        AND entityType='attachment_organization' AND entityId=? AND status='unresolved' LIMIT 1`)
        .get(profileId,p.id) as {id:string} | undefined;
      if (conflict) {
        db.prepare("UPDATE sync_conflicts SET remotePayload=?,remoteVersion=? WHERE id=?").run(JSON.stringify(p),p.version,conflict.id);
        continue;
      }
      const pending = db.prepare(`SELECT baseVersion FROM sync_outbox WHERE profileId=? AND scopeKey='personal'
        AND entityType='attachment_organization' AND entityId=? ORDER BY rowid LIMIT 1`).get(profileId,p.id) as {baseVersion:number} | undefined;
      if (pending) {
        if (pending.baseVersion !== p.version && (!local || !sameAssetOrganization(local,p))) recordConflict(db, {
          profileId,scopeKey:"personal",entityType:"attachment_organization",entityId:String(p.id),localPayload:local,
          remotePayload:p,remoteVersion:Number(p.version),
        });
        continue;
      }
      applicable.push(p);
    }
    applyAssetMetadataLocal(db,applicable,userId);
  })();
}

/** Apply all organization entries together: IDs need not arrive in parent order. */
export function applyAssetMetadataLocal(db: Database.Database, entries: Record<string, unknown>[], userId: string): void {
  db.transaction(() => runWithOutboxSuppressed(() => runChangeFeedSuppressed(db, () => {
    for (const p of entries) {
      assertAssetMetadata(String(p.id),p,userId);
      const current = db.prepare("SELECT userId FROM asset_sync_metadata WHERE id=?").get(p.id) as { userId: string } | undefined;
      if (current && current.userId !== userId) throw new SyncError("SCOPE_FORBIDDEN", "附件目录身份不匹配");
      db.prepare(`INSERT INTO asset_sync_metadata(id,userId,version,payload) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET version=excluded.version,payload=excluded.payload`)
        .run(p.id,userId,p.version,JSON.stringify(p));
      if (p.kind === "folder") {
        if (p.deleted) db.prepare(`DELETE FROM attachment_folders WHERE id=? AND userId=?
          AND NOT EXISTS (SELECT 1 FROM attachments WHERE folderId=attachment_folders.id)
          AND NOT EXISTS (SELECT 1 FROM attachment_folders child WHERE child.parentId=attachment_folders.id)`)
          .run(p.resourceId,userId);
        else db.prepare(`INSERT INTO attachment_folders(id,userId,name,parentId,createdAt,updatedAt)
          VALUES (?,?,?,?,COALESCE(?,datetime('now')),COALESCE(?,datetime('now')))
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,parentId=excluded.parentId,updatedAt=excluded.updatedAt`)
          .run(p.resourceId,userId,p.name,p.parentId,p.createdAt ?? null,p.updatedAt ?? null);
      } else {
        // The binary/attachment entity owns existence. Organization never deletes bytes.
        const changed = db.prepare("UPDATE attachments SET folderId=?,trashedAt=CASE WHEN ?=1 THEN trashedAt ELSE ? END,originalFolderId=? WHERE id=? AND userId=? AND workspaceId IS NULL")
          .run(p.deleted || p.trashedAt ? null : p.folderId,p.deleted,p.trashedAt??null,p.originalFolderId??null,p.resourceId,userId);
        if(changed.changes && (p.trashedAt || p.deleted)) setAttachmentExternalAccessEnabled(String(p.resourceId),false,db);
      }
    }
    // A deleted remote parent may still anchor an offline position in conflict.
    // Retain that local context until the dependent intention has been resolved.
    while (db.prepare(`DELETE FROM attachment_folders WHERE userId=? AND id IN
      (SELECT json_extract(payload,'$.resourceId') FROM asset_sync_metadata WHERE userId=?
        AND json_extract(payload,'$.kind')='folder' AND json_extract(payload,'$.deleted')=1)
      AND NOT EXISTS (SELECT 1 FROM attachments WHERE folderId=attachment_folders.id)
      AND NOT EXISTS (SELECT 1 FROM attachment_folders child WHERE child.parentId=attachment_folders.id)`)
      .run(userId,userId).changes) { /* Resolve empty children before their parents. */ }
    const folders = db.prepare("SELECT id,parentId FROM attachment_folders WHERE userId=?").all(userId) as { id: string; parentId: string | null }[];
    const parents = new Map(folders.map((row) => [row.id,row.parentId]));
    for (const row of folders) {
      const seen = new Set<string>();
      let id: string | null = row.id;
      while (id) {
        if (seen.has(id) || !parents.has(id)) throw new SyncError("INVALID_PAYLOAD", "附件目录缺少父节点或形成循环");
        seen.add(id); id = parents.get(id)!;
      }
    }
  })))();
}
