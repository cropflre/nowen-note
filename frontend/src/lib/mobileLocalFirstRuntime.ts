import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { getCurrentWorkspace, getServerUrl, setCurrentWorkspace, SERVER_URL_CHANGED_EVENT } from "./api.impl";
import { getAccessToken } from "./authSession";
import {
  getAllNotebooks,
  getAllNotes,
  getAllOfflineAttachmentJobs,
  getAllTags,
  getOfflineAttachmentsByNote,
  setCurrentUser,
  type OfflineAttachmentRecord,
} from "./localStore";
import { installMobileLocalFirstBridge } from "./mobileLocalFirstBridge";
import { migrateMobileLocalAccount } from "./mobileLocalAccountMigration";
import { createMobileSyncEngine, type MobileSyncEngine } from "./mobileSyncEngine";
import { createNativeAttachmentStore } from "./nativeAttachmentStore";
import { openNativeDatabase, type NativeDatabase } from "./nativeDatabase";
import { createNativeLocalRepository } from "./nativeLocalRepository";
import { newLocalId, setLocalRepository } from "./localRepository";
import { clearQueue, getQueue } from "./offlineQueue";
import { setSyncLocalAdminAdapter, SYNC_CONFLICT_ENTITY_TYPES } from "./syncLocalApi";
import type { NativeLocalRepository } from "./nativeLocalRepository";
import {
  MOBILE_LOCAL_ACCOUNT_ID,
  MOBILE_LOCAL_MODE_CHANGED_EVENT,
  MOBILE_LOCAL_USER_ID,
  MobileLocalModeRemoteRequestError,
  isMobileLocalMode,
} from "./mobileLocalMode";

const MIGRATION_KEY = "indexeddbMigrationV1";
const QUEUE_MIGRATION_KEY = "legacyOfflineQueueMigrationV1";
const DEVICE_KEY = "nowen.localFirst.deviceId";
const PROFILE_PREFIX = "nowen.localFirst.profile.";
const TOKEN_PREFIX = "nowen.localFirst.token.";

interface RuntimeHandle {
  identity: string;
  db: NativeDatabase;
  engine?: MobileSyncEngine;
  restoreBridge: () => void;
  removeListeners: Array<() => Promise<void> | void>;
}

let active: RuntimeHandle | null = null;
let lifecycle = Promise.resolve();
let globalListenersInstalled = false;

function now(): string {
  return new Date().toISOString();
}

function decodeUserId(token: string): string | null {
  try {
    const body = token.split(".")[1];
    if (!body) return null;
    const normalized = body.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as Record<string, unknown>;
    const value = payload.userId || payload.id || payload.sub;
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

function scopeFor(workspaceId: unknown): { scopeKey: string; workspaceId: string | null } {
  const value = typeof workspaceId === "string" && workspaceId && workspaceId !== "personal"
    ? workspaceId
    : null;
  return { scopeKey: value ? `workspace:${value}` : "personal", workspaceId: value };
}

async function secureStorage() {
  const module = await import("@aparajita/capacitor-secure-storage");
  try { await module.SecureStorage.setKeyPrefix("nowen_"); } catch { /* 已设置时可继续 */ }
  return module.SecureStorage;
}

async function secureGet(key: string): Promise<string | null> {
  try {
    const value = await (await secureStorage()).get(key);
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

async function secureSet(key: string, value: string): Promise<void> {
  try { await (await secureStorage()).set(key, value); } catch { /* SQLite 仍可继续工作 */ }
}

async function ensureIdentity(serverUrl: string, userId: string, token: string) {
  const accountId = `${serverUrl.toLowerCase()}\n${userId}`;
  const storageKey = btoa(unescape(encodeURIComponent(accountId))).replace(/[^A-Za-z0-9]/g, "").slice(0, 48);
  let deviceId = await secureGet(DEVICE_KEY);
  if (!deviceId) {
    deviceId = newLocalId();
    await secureSet(DEVICE_KEY, deviceId);
  }
  let profileId = await secureGet(`${PROFILE_PREFIX}${storageKey}`);
  if (!profileId) {
    profileId = newLocalId();
    await secureSet(`${PROFILE_PREFIX}${storageKey}`, profileId);
  }
  await secureSet(`${TOKEN_PREFIX}${storageKey}`, token);
  return { accountId, deviceId, profileId };
}

async function importIndexedDbCache(
  db: NativeDatabase,
  accountId: string,
  userId: string,
): Promise<void> {
  const marker = (await db.query<{ value: string }>(
    "SELECT value FROM native_runtime_meta WHERE key=?",
    [MIGRATION_KEY],
  ))[0]?.value;
  if (marker === "complete") return;

  setCurrentUser(userId);
  const [notebooks, notes, tags, jobs] = await Promise.all([
    getAllNotebooks(),
    getAllNotes(),
    getAllTags(),
    getAllOfflineAttachmentJobs(),
  ]);
  const attachments = new Map<string, OfflineAttachmentRecord>();
  for (const note of notes) {
    for (const attachment of await getOfflineAttachmentsByNote(note.id)) {
      attachments.set(attachment.id, attachment);
    }
  }
  const pendingAttachments = new Set(jobs.map((job) => job.id));
  const attachmentStore = await createNativeAttachmentStore(accountId);

  await db.run(
    `INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?, 'running', ?)
     ON CONFLICT(key) DO UPDATE SET value='running',updatedAt=excluded.updatedAt`,
    [MIGRATION_KEY, now()],
  );

  const notebookIndex = new Map(notebooks.map((item) => [`${scopeFor(item.workspaceId).scopeKey}:${item.id}`,item]));
  const depth = (item:(typeof notebooks)[number],seen=new Set<string>()):number => {
    const key = `${scopeFor(item.workspaceId).scopeKey}:${item.id}`;
    if (!item.parentId || seen.has(key)) return 0;
    const parent = notebookIndex.get(`${scopeFor(item.workspaceId).scopeKey}:${item.parentId}`);
    if (!parent) return 0;
    seen.add(key);
    return 1 + depth(parent,seen);
  };
  const orderedNotebooks = [...notebooks].sort((a,b) => depth(a)-depth(b));
  await db.transaction(async (tx) => {
    for (const notebook of orderedNotebooks) {
      const scope = scopeFor(notebook.workspaceId);
      await tx.run(`INSERT INTO notebooks (
        id,scopeKey,workspaceId,userId,parentId,name,description,icon,color,sortOrder,isExpanded,isDeleted,deletedAt,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?) ON CONFLICT(scopeKey,id) DO UPDATE SET
        parentId=excluded.parentId,name=excluded.name,description=excluded.description,icon=excluded.icon,
        color=excluded.color,sortOrder=excluded.sortOrder,isExpanded=excluded.isExpanded,updatedAt=excluded.updatedAt`, [
        notebook.id,scope.scopeKey,scope.workspaceId,notebook.userId || userId,
        notebook.parentId && notebookIndex.has(`${scope.scopeKey}:${notebook.parentId}`) ? notebook.parentId : null,
        notebook.name,notebook.description || null,notebook.icon || "📒",notebook.color || null,
        notebook.sortOrder || 0,notebook.isExpanded ?? 1,notebook.createdAt || now(),notebook.updatedAt || now(),
      ]);
    }
    for (const tag of tags) {
      const scope = scopeFor(tag.workspaceId);
      await tx.run(`INSERT INTO tags (id,scopeKey,workspaceId,userId,name,color,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scopeKey,id) DO UPDATE SET
        name=excluded.name,color=excluded.color,updatedAt=excluded.updatedAt`, [
        tag.id,scope.scopeKey,scope.workspaceId,tag.userId || userId,tag.name,tag.color || "#58a6ff",
        tag.createdAt || now(),tag.createdAt || now(),
      ]);
    }
    for (const note of notes) {
      const scope = scopeFor(note.workspaceId);
      const notebookExists = (await tx.query<{ id: string }>(
        "SELECT id FROM notebooks WHERE scopeKey=? AND id=?",
        [scope.scopeKey,note.notebookId],
      ))[0];
      if (!notebookExists) continue;
      await tx.run(`INSERT INTO notes (
        id,scopeKey,workspaceId,userId,notebookId,title,content,contentText,contentFormat,isPinned,isFavorite,isLocked,isArchived,isTrashed,trashedAt,version,sortOrder,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scopeKey,id) DO UPDATE SET
        notebookId=excluded.notebookId,title=excluded.title,content=excluded.content,contentText=excluded.contentText,
        contentFormat=excluded.contentFormat,isPinned=excluded.isPinned,isFavorite=excluded.isFavorite,
        isLocked=excluded.isLocked,isArchived=excluded.isArchived,isTrashed=excluded.isTrashed,
        trashedAt=excluded.trashedAt,version=excluded.version,sortOrder=excluded.sortOrder,updatedAt=excluded.updatedAt`, [
        note.id,scope.scopeKey,scope.workspaceId,note.userId || userId,note.notebookId,note.title || "无标题笔记",
        note.content ?? "{}",note.contentText ?? "",note.contentFormat || "tiptap-json",note.isPinned || 0,
        note.isFavorite || 0,note.isLocked || 0,note.isArchived || 0,note.isTrashed || 0,note.trashedAt || null,
        note.version || 1,note.sortOrder || 0,note.createdAt || now(),note.updatedAt || now(),
      ]);
      for (const tag of note.tags || []) {
        const tagExists = (await tx.query<{id:string}>(
          "SELECT id FROM tags WHERE scopeKey=? AND id=?",[scope.scopeKey,tag.id],
        ))[0];
        if (!tagExists) continue;
        await tx.run("INSERT OR IGNORE INTO note_tags (scopeKey,workspaceId,noteId,tagId,createdAt) VALUES (?,?,?,?,?)", [
          scope.scopeKey,scope.workspaceId,note.id,tag.id,now(),
        ]);
      }
    }
  });

  for (const attachment of attachments.values()) {
    const note = notes.find((item) => item.id === attachment.noteId);
    if (!note) continue;
    const scope = scopeFor(note.workspaceId);
    try {
      const stored = await attachmentStore.save({ attachmentId:attachment.id,data:attachment.blob,expectedSize:attachment.size });
      const transferStatus = pendingAttachments.has(attachment.id) ? "pending_upload" : "ready";
      await db.run(`INSERT INTO attachments (
        id,scopeKey,workspaceId,noteId,userId,filename,mimeType,size,localPath,hash,available,transferStatus,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(scopeKey,id) DO UPDATE SET
        localPath=excluded.localPath,hash=excluded.hash,available=1,
        transferStatus=excluded.transferStatus,updatedAt=excluded.updatedAt`, [
        attachment.id,scope.scopeKey,scope.workspaceId,attachment.noteId,userId,attachment.filename,
        attachment.mimeType,stored.size,stored.path,stored.sha256,transferStatus,attachment.createdAt || now(),now(),
      ]);
    } catch {
      // 单个历史缓存损坏不阻断其余数据迁移；首次同步会重新下载远端二进制。
    }
  }
  await db.run(
    `INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?, 'complete', ?)
     ON CONFLICT(key) DO UPDATE SET value='complete',updatedAt=excluded.updatedAt`,
    [MIGRATION_KEY, now()],
  );
}

async function migrateLegacyOfflineQueue(
  db:NativeDatabase,
  profileId:string,
  deviceId:string,
):Promise<void> {
  const marker=(await db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?",[QUEUE_MIGRATION_KEY]))[0]?.value;
  if(marker === "complete") { clearQueue(); return; }
  const queue=getQueue();
  await db.transaction(async(tx)=>{
    for(const item of queue){
      const payload=item.localPayload || item.body || undefined;
      const rawWorkspaceId=payload?.workspaceId;
      const scope=scopeFor(rawWorkspaceId);
      const operation=item.type === "deleteNote" ? "delete" : "upsert";
      const rawVersion=payload?.version;
      const baseVersion=item.type === "updateNote" && Number.isSafeInteger(Number(rawVersion))
        ? Number(rawVersion) : null;
      await tx.run(`INSERT OR IGNORE INTO sync_outbox (
        id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,baseVersion,payload,status,retryCount,createdAt
      ) VALUES (?,?,?,?,?,'note',?,?,?,?,'pending',0,?)`,[
        newLocalId(),newLocalId(),profileId,deviceId,scope.scopeKey,item.noteId,operation,
        baseVersion,payload?JSON.stringify({...payload,id:item.noteId,workspaceId:scope.workspaceId}):null,
        new Date(item.enqueuedAt).toISOString(),
      ]);
    }
    const pending=await tx.query<{
      id:string;scopeKey:string;workspaceId:string|null;noteId:string;userId:string;
      filename:string;mimeType:string;size:number;hash:string|null;createdAt:string;
    }>("SELECT id,scopeKey,workspaceId,noteId,userId,filename,mimeType,size,hash,createdAt FROM attachments WHERE transferStatus='pending_upload'");
    for(const row of pending){
      await tx.run(`INSERT OR IGNORE INTO sync_outbox (
        id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,payload,status,retryCount,createdAt
      ) VALUES (?,?,?,?,?,'attachment',?,'upsert',?,'pending',0,?)`,[
        newLocalId(),newLocalId(),profileId,deviceId,row.scopeKey,row.id,JSON.stringify(row),row.createdAt,
      ]);
    }
    await tx.run(`INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,'complete',?)
      ON CONFLICT(key) DO UPDATE SET value='complete',updatedAt=excluded.updatedAt`,[QUEUE_MIGRATION_KEY,now()]);
  });
  clearQueue();
}

function createNativeAdminAdapter(
  db:NativeDatabase,
  engine:MobileSyncEngine,
  repository:NativeLocalRepository,
  profileId:string,
  deviceId:string,
  serverUrl:string,
) {
  const parseBody=(init?:RequestInit)=>init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:{};
  const json=(value:string|null)=>{try{return value?JSON.parse(value) as Record<string,unknown>:null;}catch{return null;}};
  const diff=(local:Record<string,unknown>|null,remote:Record<string,unknown>|null)=>local&&remote
    ? [...new Set([...Object.keys(local),...Object.keys(remote)])].filter((key)=>!["version","updatedAt"].includes(key)&&JSON.stringify(local[key])!==JSON.stringify(remote[key])).sort()
    : [];
  return async<T>(path:string,init?:RequestInit):Promise<T>=>{
    const method=(init?.method||"GET").toUpperCase();
    const active=(await db.query<{enabled:number;createdAt:string;authStatus:string}>("SELECT enabled,createdAt,authStatus FROM sync_profiles WHERE id=?",[profileId]))[0];
    if(path==="/settings"&&method==="GET"){
      const authorized=active?.authStatus==="ready";
      return {mode:active?.enabled===1?"server":"device-only",activeProfile:active?.enabled===1?{id:profileId,name:"当前账号",serverUrl,enabled:true,createdAt:active.createdAt}:null,profiles:active?[{id:profileId,name:"当前账号",serverUrl,enabled:active.enabled===1,createdAt:active.createdAt}]:[],authorized,authorizationState:authorized?"ready":"expired",engineRunning:active?.enabled===1&&authorized} as T;
    }
    if(path==="/settings/disable"&&method==="POST"){
      const count=(await db.query<{count:number}>("SELECT COUNT(*) AS count FROM sync_outbox WHERE profileId=?",[profileId]))[0]?.count||0;
      await db.run("UPDATE sync_profiles SET enabled=0,updatedAt=? WHERE id=?",[now(),profileId]);engine.stop();
      return {mode:"device-only",retainedPendingMutations:count,message:"已停止同步，此设备中的全部笔记仍完整保留。"} as T;
    }
    if(path==="/settings/server"&&method==="POST"){
      const body=parseBody(init);if(String(body.serverUrl||"").replace(/\/+$/,"")!==serverUrl)throw new Error("移动端请先在登录页切换服务器");
      await db.run("UPDATE sync_profiles SET enabled=1,authStatus='ready',updatedAt=? WHERE id=?",[now(),profileId]);engine.start();
      return {mode:"server",profile:{id:profileId,name:"当前账号",serverUrl,enabled:true},deviceId,authorized:true,engineRunning:true,message:"已恢复同步"} as T;
    }
    if(path==="/engine"){const state=await repository.sync.getState();return {running:active?.enabled===1,state:state.mode==="server"?(state.conflictCount?"conflict":state.lastError?"error":"idle"):"disabled",pendingCount:state.mode==="server"?state.pendingMutations:0,conflictCount:state.mode==="server"?state.conflictCount:0,lastError:state.mode==="server"?state.lastError:null,localAuthoritative:true} as T;}
    if(path==="/sync-now"&&method==="POST"){engine.requestSync(0);return {engineRunning:active?.enabled===1,message:"已请求立即同步"} as T;}
    if(path==="/diagnostics"){
      const state=(await db.query<{lastSequence:number;lastSyncAt:string|null;lastError:string|null}>("SELECT lastSequence,lastSyncAt,lastError FROM sync_state WHERE profileId=? AND scopeKey='personal'",[profileId]))[0];
      const pending=await db.query<Record<string,unknown>>("SELECT scopeKey,entityType,entityId,operation,status,retryCount,lastError,createdAt FROM sync_outbox WHERE profileId=? AND status IN ('pending','failed') ORDER BY createdAt LIMIT 20",[profileId]);
      const pendingCount=(await db.query<{count:number}>("SELECT COUNT(*) AS count FROM sync_outbox WHERE profileId=? AND status IN ('pending','failed')",[profileId]))[0]?.count||0;
      const conflictCount=(await db.query<{count:number}>("SELECT COUNT(*) AS count FROM sync_conflicts WHERE profileId=? AND status='unresolved'",[profileId]))[0]?.count||0;
      return {profileId,serverUrl,deviceId,lastSeenAt:null,localCursor:state?.lastSequence||0,lastSyncAt:state?.lastSyncAt||null,lastError:state?.lastError||null,pendingMutations:pendingCount,conflictCount,pendingSample:pending} as T;
    }
    if(path==="/scopes"){
      const rows=await db.query<Record<string,unknown>>("SELECT * FROM sync_workspace_scopes WHERE profileId=? ORDER BY workspaceName",[profileId]);
      for(const row of rows){row.pendingMutations=(await db.query<{count:number}>("SELECT COUNT(*) AS count FROM sync_outbox WHERE profileId=? AND scopeKey=? AND status IN ('pending','failed')",[profileId,row.scopeKey]))[0]?.count||0;row.conflictCount=(await db.query<{count:number}>("SELECT COUNT(*) AS count FROM sync_conflicts WHERE profileId=? AND scopeKey=? AND status='unresolved'",[profileId,row.scopeKey]))[0]?.count||0;}
      return {items:rows} as T;
    }
    if(path==="/conflicts"){
      const rows=await db.query<{id:string;entityType:string;entityId:string;localVersion:number|null;remoteVersion:number|null;localPayload:string|null;remotePayload:string|null;createdAt:string}>("SELECT * FROM sync_conflicts WHERE profileId=? AND status='unresolved' ORDER BY createdAt",[profileId]);
      return {total:rows.length,items:rows.map((row)=>{const local=json(row.localPayload),remote=json(row.remotePayload);return {id:row.id,entityType:row.entityType,entityId:row.entityId,localVersion:row.localVersion,remoteVersion:row.remoteVersion,createdAt:row.createdAt,diffFields:diff(local,remote),localTitle:typeof local?.title==="string"?local.title:null,remoteTitle:typeof remote?.title==="string"?remote.title:null};})} as T;
    }
    const historyUrl=new URL(path,"http://localhost");
    if(historyUrl.pathname==="/conflicts/history"&&method==="GET"){
      const requestedLimit=Number(historyUrl.searchParams.get("limit")||20);
      const requestedOffset=Number(historyUrl.searchParams.get("offset")||0);
      const limit=Math.max(1,Math.min(200,Math.trunc(requestedLimit)||20));
      const offset=Math.max(0,Math.trunc(requestedOffset)||0);
      const entityType=historyUrl.searchParams.get("entityType")||null;
      if(entityType&&!(SYNC_CONFLICT_ENTITY_TYPES as readonly string[]).includes(entityType))throw new Error("不支持的冲突实体类型");
      const where=entityType
        ? "profileId=? AND status='resolved' AND entityType=?"
        : "profileId=? AND status='resolved'";
      const params=entityType?[profileId,entityType]:[profileId];
      const total=(await db.query<{count:number}>(`SELECT COUNT(*) AS count FROM sync_conflicts WHERE ${where}`,params))[0]?.count||0;
      const rows=await db.query<{id:string;entityType:string;entityId:string;localVersion:number|null;remoteVersion:number|null;localPayload:string|null;remotePayload:string|null;createdAt:string;resolvedAt:string}>(
        `SELECT * FROM sync_conflicts WHERE ${where} ORDER BY resolvedAt DESC,createdAt DESC,id DESC LIMIT ? OFFSET ?`,
        [...params,limit,offset],
      );
      return {total,limit,offset,hasMore:offset+rows.length<total,items:rows.map((row)=>{const local=json(row.localPayload),remote=json(row.remotePayload);return {id:row.id,entityType:row.entityType,entityId:row.entityId,localVersion:row.localVersion,remoteVersion:row.remoteVersion,createdAt:row.createdAt,resolvedAt:row.resolvedAt,diffFields:diff(local,remote),localTitle:typeof local?.title==="string"?local.title:null,remoteTitle:typeof remote?.title==="string"?remote.title:null};})} as T;
    }
    const conflictMatch=path.match(/^\/conflicts\/([^/]+)$/);
    if(conflictMatch&&method==="GET"){
      const id=decodeURIComponent(conflictMatch[1]);const row=(await db.query<any>("SELECT * FROM sync_conflicts WHERE id=?",[id]))[0];if(!row)throw new Error("冲突不存在");
      const local=json(row.localPayload),remote=json(row.remotePayload);return {...row,base:json(row.basePayload),local,remote,diffFields:diff(local,remote),localTitle:typeof local?.title==="string"?local.title:null,remoteTitle:typeof remote?.title==="string"?remote.title:null} as T;
    }
    const resolveMatch=path.match(/^\/conflicts\/([^/]+)\/resolve$/);
    if(resolveMatch&&method==="POST"){const body=parseBody(init);await engine.resolveLocalConflict(decodeURIComponent(resolveMatch[1]),body.resolution as any,body.mergedPayload as Record<string,unknown>|undefined);const remaining=(await db.query<{count:number}>("SELECT COUNT(*) AS count FROM sync_conflicts WHERE profileId=? AND status='unresolved'",[profileId]))[0]?.count||0;return {conflictId:decodeURIComponent(resolveMatch[1]),resolution:body.resolution,remainingConflicts:remaining} as T;}
    const reopenMatch=path.match(/^\/conflicts\/([^/]+)\/reopen$/);
    if(reopenMatch&&method==="POST"){
      const conflictId=decodeURIComponent(reopenMatch[1]);
      const existing=(await db.query<{status:string}>("SELECT status FROM sync_conflicts WHERE id=? AND profileId=?",[conflictId,profileId]))[0];
      if(!existing)throw new Error("冲突不存在");
      const reopened=existing.status==="resolved";
      if(reopened)await db.run("UPDATE sync_conflicts SET status='unresolved',resolvedAt=NULL WHERE id=? AND profileId=? AND status='resolved'",[conflictId,profileId]);
      const remaining=(await db.query<{count:number}>("SELECT COUNT(*) AS count FROM sync_conflicts WHERE profileId=? AND status='unresolved'",[profileId]))[0]?.count||0;
      return {conflictId,reopened,alreadyOpen:!reopened,remainingConflicts:remaining,message:reopened?"已重新放回冲突中心，请重新选择要采用的版本。":"该冲突已在待处理列表中。"} as T;
    }
    const forkMatch=path.match(/^\/conflicts\/([^/]+)\/fork$/);
    if(forkMatch&&method==="POST"){const body=parseBody(init);return {noteId:await engine.forkLocalConflict(decodeURIComponent(forkMatch[1]),body.side as "local"|"remote")} as T;}
    const exportMatch=path.match(/^\/scopes\/([^/]+)\/export$/);
    if(exportMatch)return await repository.exportWorkspaceScope(decodeURIComponent(exportMatch[1])) as T;
    const copyMatch=path.match(/^\/scopes\/([^/]+)\/copy-to-personal$/);
    if(copyMatch&&method==="POST"){const copied=await repository.copyWorkspaceScopeToPersonal(decodeURIComponent(copyMatch[1]));return {copied,message:"已复制到个人空间，原工作区副本保持不变。"} as T;}
    throw new Error(`移动端同步管理接口不支持：${method} ${path}`);
  };
}

function createDeviceOnlyAdminAdapter(repository: NativeLocalRepository) {
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    const method = (init?.method || "GET").toUpperCase();
    if (path === "/settings" && method === "GET") {
      return {
        mode: "device-only",
        activeProfile: null,
        profiles: [],
        authorized: false,
        authorizationState: "missing",
        engineRunning: false,
      } as T;
    }
    if (path === "/settings/disable" && method === "POST") {
      return {
        mode: "device-only",
        retainedPendingMutations: 0,
        message: "当前已是设备本地模式。",
      } as T;
    }
    if (path === "/engine") {
      return {
        running: false,
        state: "disabled",
        pendingCount: 0,
        conflictCount: 0,
        lastError: null,
        localAuthoritative: true,
      } as T;
    }
    if (path === "/sync-now" && method === "POST") {
      return { engineRunning: false, message: "登录账号后才能同步。" } as T;
    }
    if (path === "/diagnostics") {
      return {
        profileId: null,
        serverUrl: null,
        deviceId: null,
        lastSeenAt: null,
        localCursor: 0,
        lastSyncAt: null,
        lastError: null,
        pendingMutations: 0,
        conflictCount: 0,
        pendingSample: [],
      } as T;
    }
    if (path === "/scopes") return { items: [] } as T;
    if (path === "/conflicts") return { total: 0, items: [] } as T;
    if (new URL(path, "http://localhost").pathname === "/conflicts/history") {
      return { total: 0, limit: 20, offset: 0, hasMore: false, items: [] } as T;
    }
    const exportMatch = path.match(/^\/scopes\/([^/]+)\/export$/);
    if (exportMatch && method === "GET") {
      return await repository.exportWorkspaceScope(decodeURIComponent(exportMatch[1])) as T;
    }
    throw new MobileLocalModeRemoteRequestError(`/sync/local${path}`);
  };
}

async function disposeActive(): Promise<void> {
  const current = active;
  active = null;
  if (!current) return;
  current.engine?.stop();
  for (const remove of current.removeListeners) await remove();
  current.restoreBridge();
  setLocalRepository(null);
  setSyncLocalAdminAdapter(null);
  await current.db.close();
}

async function configureRuntime(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (isMobileLocalMode()) {
    const identity = `local\n${MOBILE_LOCAL_ACCOUNT_ID}`;
    if (active?.identity === identity) return;
    await disposeActive();
    setCurrentUser(MOBILE_LOCAL_USER_ID);
    setCurrentWorkspace("personal");
    const db = await openNativeDatabase(MOBILE_LOCAL_ACCOUNT_ID);
    let restoreBridge: () => void = () => undefined;
    try {
      const attachmentStore = await createNativeAttachmentStore(MOBILE_LOCAL_ACCOUNT_ID);
      const repository = createNativeLocalRepository({
        db,
        attachments: attachmentStore,
        accountId: MOBILE_LOCAL_ACCOUNT_ID,
        userId: MOBILE_LOCAL_USER_ID,
        getScopeKey: () => "personal",
      });
      await repository.warmAttachmentUrls();
      setLocalRepository(repository);
      setSyncLocalAdminAdapter(createDeviceOnlyAdminAdapter(repository));
      restoreBridge = installMobileLocalFirstBridge(repository,db,MOBILE_LOCAL_USER_ID);
      active = { identity, db, restoreBridge, removeListeners: [] };
    } catch (error) {
      restoreBridge();
      setLocalRepository(null);
      setSyncLocalAdminAdapter(null);
      await db.close().catch(() => undefined);
      throw error;
    }
    return;
  }
  const token = getAccessToken();
  const userId = token ? decodeUserId(token) : null;
  const serverUrl = getServerUrl().replace(/\/+$/, "");
  if (!token || !userId || !serverUrl) {
    await disposeActive();
    return;
  }
  const identity = `${serverUrl}\n${userId}\n${token}`;
  if (active?.identity === identity) return;
  await disposeActive();

  const ids = await ensureIdentity(serverUrl,userId,token);
  const db = await openNativeDatabase(ids.accountId);
  try {
    await importIndexedDbCache(db,ids.accountId,userId);
    const attachmentStore = await createNativeAttachmentStore(ids.accountId);
    await db.transaction(async (tx) => {
      await tx.run("UPDATE sync_profiles SET enabled=0 WHERE enabled=1 AND id<>?",[ids.profileId]);
      await tx.run(`INSERT INTO sync_profiles (
        id,name,serverUrl,remoteUserId,enabled,authStatus,bootstrapStatus,createdAt,updatedAt
      ) VALUES (?,?,?,?,1,'ready','pending',?,?) ON CONFLICT(id) DO UPDATE SET
        serverUrl=excluded.serverUrl,remoteUserId=excluded.remoteUserId,enabled=1,authStatus='ready',updatedAt=excluded.updatedAt`, [
        ids.profileId,"当前账号",serverUrl,userId,now(),now(),
      ]);
      await tx.run(`INSERT INTO sync_devices (profileId,deviceId,deviceName,platform,createdAt,lastSeenAt)
        VALUES (?,?,?,?,?,?) ON CONFLICT(profileId,deviceId) DO UPDATE SET lastSeenAt=excluded.lastSeenAt`, [
        ids.profileId,ids.deviceId,"移动设备",Capacitor.getPlatform(),now(),now(),
      ]);
    });
    const mobileLocalDb = await openNativeDatabase(MOBILE_LOCAL_ACCOUNT_ID);
    try {
      await migrateMobileLocalAccount({
        sourceDb: mobileLocalDb,
        sourceAttachments: await createNativeAttachmentStore(MOBILE_LOCAL_ACCOUNT_ID),
        targetDb: db,
        targetAttachments: attachmentStore,
        targetUserId: userId,
        profileId: ids.profileId,
        deviceId: ids.deviceId,
      });
    } finally {
      await mobileLocalDb.close().catch(() => undefined);
    }
    await migrateLegacyOfflineQueue(db,ids.profileId,ids.deviceId);
    let repository!:NativeLocalRepository;
    const engine = createMobileSyncEngine({
      db,attachments:attachmentStore,serverUrl,token,userId,profileId:ids.profileId,deviceId:ids.deviceId,
      onAttachmentReady:(id)=>{void repository?.refreshAttachmentUrl(id);},
    });
    repository = createNativeLocalRepository({
      db,attachments:attachmentStore,accountId:ids.accountId,userId,
      getScopeKey: () => getCurrentWorkspace(),requestSync: () => engine.requestSync(),
    });
    await repository.warmAttachmentUrls();
    const removeListeners: RuntimeHandle["removeListeners"] = [];
    const [{ App }, { Network }] = await Promise.all([import("@capacitor/app"),import("@capacitor/network")]);
    const appHandle = await App.addListener("appStateChange", ({ isActive }) => { if (isActive) engine.requestSync(0); });
    let networkHandle:PluginListenerHandle;
    try {
      networkHandle = await Network.addListener("networkStatusChange", ({ connected }) => { if (connected) engine.requestSync(0); });
    } catch (error) {
      await appHandle.remove();
      throw error;
    }
    removeListeners.push(() => appHandle.remove(),() => networkHandle.remove());
    setLocalRepository(repository);
    setSyncLocalAdminAdapter(createNativeAdminAdapter(db,engine,repository,ids.profileId,ids.deviceId,serverUrl));
    const restoreBridge = installMobileLocalFirstBridge(repository,db,userId);
    active = {identity,db,engine,restoreBridge,removeListeners};
    engine.start();
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
}

function scheduleConfigure(): void {
  lifecycle = lifecycle.then(configureRuntime,configureRuntime).catch((error) => {
    console.error("[mobile-local-first] 初始化失败，已保留原有访问路径",error);
  });
}

/** 原生端启动入口。失败时保留既有远端路径，避免阻断登录或首屏。 */
export async function initializeMobileLocalFirstRuntime(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (!globalListenersInstalled) {
    globalListenersInstalled = true;
    window.addEventListener("nowen:token-changed",scheduleConfigure);
    window.addEventListener(SERVER_URL_CHANGED_EVENT,scheduleConfigure);
    window.addEventListener(MOBILE_LOCAL_MODE_CHANGED_EVENT,scheduleConfigure);
  }
  scheduleConfigure();
  await lifecycle;
}
