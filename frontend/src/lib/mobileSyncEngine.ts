import type { NativeDatabase } from "./nativeDatabase";
import type { NativeAttachmentStore } from "./nativeAttachmentStore";
import { newLocalId } from "./localRepository";

type ScopeStatus = "active" | "replan_required" | "access_revoked";
type EntityType = "notebook" | "note" | "tag" | "note_tag" | "favorite" | "attachment"
  | "task" | "task_reminder" | "diary" | "mindmap";
type RemoteEntityType = EntityType;

interface ScopeDescriptor {
  scopeKey: string;
  workspaceId: string | null;
  workspaceName: string | null;
  role: string | null;
  canWrite: boolean;
  accessFingerprint: string;
}

interface MobileSyncOptions {
  db: NativeDatabase;
  attachments: NativeAttachmentStore;
  serverUrl: string;
  token: string;
  userId: string;
  profileId: string;
  deviceId: string;
  onAuthRequired?: () => void;
  onAttachmentReady?: (attachmentId:string) => void;
}

interface SnapshotEntry {
  entityType: RemoteEntityType;
  entityId: string;
  payload: Record<string, unknown>;
}

function now(): string { return new Date().toISOString(); }

function workspaceId(scopeKey: string): string | null {
  return scopeKey.startsWith("workspace:") ? scopeKey.slice("workspace:".length) : null;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["updatedAt", "createdAt", "version"].includes(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isCoreEntityType(value:RemoteEntityType):value is EntityType {
  return value === "notebook" || value === "note" || value === "tag"
    || value === "note_tag" || value === "favorite" || value === "attachment"
    || value === "task" || value === "task_reminder" || value === "diary" || value === "mindmap";
}

function syncFailure(code:string,message:string):Error&{code:string}{
  return Object.assign(new Error(message),{code});
}

export class MobileSyncEngine {
  private running = false;
  private rerun = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly options: MobileSyncOptions) {}

  start(): void {
    this.stopped = false;
    this.requestSync(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  requestSync(delayMs = 800): void {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.syncOnce();
    }, delayMs);
  }

  async syncOnce(): Promise<void> {
    if (this.stopped) return;
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    try {
      const scopes = await this.fetchScopes();
      await this.refreshScopes(scopes);
      for (const scope of scopes) {
        const state = (await this.options.db.query<{ accessStatus: ScopeStatus; lastSequence: number }>(
          "SELECT accessStatus,lastSequence FROM sync_state WHERE profileId=? AND scopeKey=?",
          [this.options.profileId, scope.scopeKey],
        ))[0];
        if (state?.accessStatus === "access_revoked") continue;
        try {
          if (!state || state.lastSequence === 0 || state.accessStatus === "replan_required") {
            await this.bootstrap(scope);
          }
          await this.push(scope);
          await this.pull(scope);
          await this.transferAttachments(scope);
        } catch (error) {
          const code = (error as Error & { code?: string }).code;
          if (code === "ACCESS_REVOKED" || code === "SCOPE_FORBIDDEN") {
            await this.freezeScope(scope.scopeKey, code);
            continue;
          }
          if (code === "AUTH_EXPIRED") {
            await this.options.db.run("UPDATE sync_profiles SET authStatus='auth_required',updatedAt=? WHERE id=?", [now(),this.options.profileId]);
            this.options.onAuthRequired?.();
            return;
          }
          await this.options.db.run(`UPDATE sync_state SET lastError=?,lastSyncAt=?
            WHERE profileId=? AND scopeKey=?`, [code || "NETWORK_UNAVAILABLE",now(),this.options.profileId,scope.scopeKey]);
        }
      }
    } finally {
      this.running = false;
      if (this.rerun) { this.rerun = false; this.requestSync(0); }
    }
  }

  async resolveLocalConflict(
    conflictId:string,
    resolution:"keep-local"|"keep-remote"|"manual",
    mergedPayload?:Record<string,unknown>,
  ):Promise<void>{
    const row=(await this.options.db.query<{
      id:string;scopeKey:string;entityType:RemoteEntityType;entityId:string;
      localVersion:number|null;remoteVersion:number|null;localPayload:string|null;remotePayload:string|null;status:string;
    }>("SELECT * FROM sync_conflicts WHERE id=?",[conflictId]))[0];
    if(!row||row.status==="resolved")return;
    if(!isCoreEntityType(row.entityType))throw new Error("该冲突类型暂不支持在移动端合并");
    const parse=(value:string|null)=>value?JSON.parse(value) as Record<string,unknown>:null;
    const payload=resolution==="manual"?mergedPayload:parse(resolution==="keep-remote"?row.remotePayload:row.localPayload);
    if(!payload)throw new Error("缺少可用的冲突内容");
    const workspace=workspaceId(row.scopeKey);
    const stored=(await this.options.db.query<{workspaceName:string;role:string;canWrite:number;accessFingerprint:string}>(
      "SELECT workspaceName,role,canWrite,accessFingerprint FROM sync_workspace_scopes WHERE profileId=? AND scopeKey=?",
      [this.options.profileId,row.scopeKey],
    ))[0];
    const scope:ScopeDescriptor={scopeKey:row.scopeKey,workspaceId:workspace,workspaceName:stored?.workspaceName||null,
      role:stored?.role||null,canWrite:workspace?stored?.canWrite===1:true,accessFingerprint:stored?.accessFingerprint||""};
    await this.options.db.transaction(async(tx)=>{
      await tx.run(`DELETE FROM sync_outbox WHERE profileId=? AND scopeKey=?
        AND entityType=? AND entityId=? AND status IN ('pending','inflight','failed')`,
      [this.options.profileId,row.scopeKey,row.entityType,row.entityId]);
      await this.applyEntity(tx,scope,{entityType:row.entityType,entityId:row.entityId,payload});
      if(resolution!=="keep-remote"){
        await tx.run(`INSERT INTO sync_outbox (
          id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,baseVersion,payload,status,retryCount,createdAt
        ) VALUES (?,?,?,?,?,?,?,'upsert',?,?,'pending',0,?)`,[
          newLocalId(),newLocalId(),this.options.profileId,this.options.deviceId,row.scopeKey,row.entityType,row.entityId,
          row.remoteVersion,JSON.stringify({...payload,workspaceId:workspace}),now(),
        ]);
      }
      await tx.run("UPDATE sync_conflicts SET status='resolved',resolvedAt=? WHERE id=?",[now(),conflictId]);
    });
    this.requestSync(0);
  }

  async forkLocalConflict(conflictId:string,side:"local"|"remote"):Promise<string>{
    const row=(await this.options.db.query<{scopeKey:string;entityType:RemoteEntityType;localPayload:string|null;remotePayload:string|null}>(
      "SELECT scopeKey,entityType,localPayload,remotePayload FROM sync_conflicts WHERE id=?",[conflictId],
    ))[0];
    if(!row||row.entityType!=="note")throw new Error("只有笔记冲突支持另存为新笔记");
    const payload=JSON.parse(side==="local"?row.localPayload||"null":row.remotePayload||"null") as Record<string,unknown>|null;
    if(!payload)throw new Error("该版本内容不存在");
    const id=newLocalId();const workspace=workspaceId(row.scopeKey);
    const stored=(await this.options.db.query<{workspaceName:string;role:string;canWrite:number;accessFingerprint:string}>(
      "SELECT workspaceName,role,canWrite,accessFingerprint FROM sync_workspace_scopes WHERE profileId=? AND scopeKey=?",
      [this.options.profileId,row.scopeKey],
    ))[0];
    const scope:ScopeDescriptor={scopeKey:row.scopeKey,workspaceId:workspace,workspaceName:stored?.workspaceName||null,
      role:stored?.role||null,canWrite:workspace?stored?.canWrite===1:true,accessFingerprint:stored?.accessFingerprint||""};
    const next={...payload,id,workspaceId:workspace,title:`${String(payload.title||"无标题笔记")}（${side==="local"?"本机":"服务器"}版本）`,version:1};
    await this.options.db.transaction(async(tx)=>{
      await this.applyEntity(tx,scope,{entityType:"note",entityId:id,payload:next});
      await tx.run(`INSERT INTO sync_outbox (
        id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,payload,status,retryCount,createdAt
      ) VALUES (?,?,?,?,?,'note',?,'upsert',?,'pending',0,?)`,[
        newLocalId(),newLocalId(),this.options.profileId,this.options.deviceId,row.scopeKey,id,JSON.stringify(next),now(),
      ]);
    });
    this.requestSync(0);return id;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.options.serverUrl.replace(/\/+$/, "")}/api/sync/v2${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers || {}),
        },
      });
    } catch (cause) {
      throw Object.assign(new Error("网络不可用", { cause }), { code: "NETWORK_UNAVAILABLE" });
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { code?: string; error?: string };
      const code = payload.code || (response.status === 401 ? "AUTH_EXPIRED" : "SERVER_ERROR");
      throw Object.assign(new Error(payload.error || code), { code });
    }
    return await response.json() as T;
  }

  private async fetchScopes(): Promise<ScopeDescriptor[]> {
    return (await this.request<{ items: ScopeDescriptor[] }>("/scopes")).items;
  }

  private async refreshScopes(scopes: ScopeDescriptor[]): Promise<void> {
    const incoming = new Set(scopes.map((scope) => scope.scopeKey));
    await this.options.db.transaction(async (tx) => {
      for (const scope of scopes) {
        const old = (await tx.query<{ accessFingerprint: string }>(
          "SELECT accessFingerprint FROM sync_state WHERE profileId=? AND scopeKey=?",
          [this.options.profileId,scope.scopeKey],
        ))[0];
        const changed = Boolean(old && old.accessFingerprint !== scope.accessFingerprint);
        await tx.run(`INSERT INTO sync_state (
          profileId,scopeKey,lastSequence,lastSyncAt,lastError,accessFingerprint,accessStatus,accessChangedAt
        ) VALUES (?,?,0,NULL,NULL,?,?,?) ON CONFLICT(profileId,scopeKey) DO UPDATE SET
          lastSequence=CASE WHEN sync_state.accessFingerprint<>excluded.accessFingerprint THEN 0 ELSE sync_state.lastSequence END,
          accessFingerprint=excluded.accessFingerprint,
          accessStatus=CASE WHEN sync_state.accessFingerprint<>excluded.accessFingerprint THEN 'replan_required' ELSE 'active' END,
          accessChangedAt=CASE WHEN sync_state.accessFingerprint<>excluded.accessFingerprint THEN excluded.accessChangedAt ELSE sync_state.accessChangedAt END`,
        [this.options.profileId,scope.scopeKey,scope.accessFingerprint,changed?"replan_required":"active",now()]);
        if (scope.workspaceId) {
          await tx.run(`INSERT INTO sync_workspace_scopes (
            profileId,scopeKey,workspaceId,workspaceName,role,canWrite,accessFingerprint,accessStatus,updatedAt
          ) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(profileId,scopeKey) DO UPDATE SET
            workspaceName=excluded.workspaceName,role=excluded.role,canWrite=excluded.canWrite,
            accessFingerprint=excluded.accessFingerprint,accessStatus='active',updatedAt=excluded.updatedAt`, [
            this.options.profileId,scope.scopeKey,scope.workspaceId,scope.workspaceName || scope.workspaceId,
            scope.role || "viewer",scope.canWrite?1:0,scope.accessFingerprint,"active",now(),
          ]);
        }
      }
      const local = await tx.query<{ scopeKey: string }>(
        "SELECT scopeKey FROM sync_workspace_scopes WHERE profileId=?",
        [this.options.profileId],
      );
      for (const row of local) if (!incoming.has(row.scopeKey)) await this.freezeScope(row.scopeKey,"ACCESS_REVOKED",tx);
    });
  }

  private async freezeScope(scopeKey: string, code: string, db: NativeDatabase = this.options.db): Promise<void> {
    await db.run(`UPDATE sync_state SET accessStatus='access_revoked',lastError=?,accessChangedAt=?
      WHERE profileId=? AND scopeKey=?`, [code,now(),this.options.profileId,scopeKey]);
    await db.run(`UPDATE sync_workspace_scopes SET accessStatus='access_revoked',canWrite=0,updatedAt=?
      WHERE profileId=? AND scopeKey=?`, [now(),this.options.profileId,scopeKey]);
  }

  private async bootstrap(scope: ScopeDescriptor): Promise<void> {
    let cursor: string | null = null;
    let sequence = 0;
    const seen=new Map<EntityType,Set<string>>();
    const notebookParents=new Map<string,string>();
    do {
      const params = new URLSearchParams({ scopeKey:scope.scopeKey, limit:"200" });
      if (cursor) params.set("cursor",cursor);
      if (sequence) params.set("snapshotSequence",String(sequence));
      const page = await this.request<{ snapshotSequence:number;nextCursor:string|null;items:SnapshotEntry[] }>(`/snapshot?${params}`);
      if (!sequence) sequence = page.snapshotSequence;
      for(const entry of page.items){
        if(!isCoreEntityType(entry.entityType))continue;
        const ids=seen.get(entry.entityType)||new Set<string>();ids.add(entry.entityId);seen.set(entry.entityType,ids);
        if(entry.entityType==="notebook"&&typeof entry.payload.parentId==="string")notebookParents.set(entry.entityId,entry.payload.parentId);
      }
      await this.applyEntries(scope,page.items,true);
      cursor = page.nextCursor;
    } while (cursor);
    await this.restoreNotebookParents(scope,notebookParents);
    if(scope.workspaceId)await this.pruneWorkspaceSnapshot(scope,seen);
    await this.advance(scope,sequence);
  }

  private async restoreNotebookParents(scope:ScopeDescriptor,links:Map<string,string>):Promise<void>{
    if(!links.size)return;
    await this.options.db.transaction(async(tx)=>{
      for(const [id,parentId] of links){
        const parent=(await tx.query<{id:string}>("SELECT id FROM notebooks WHERE scopeKey=? AND id=?",[scope.scopeKey,parentId]))[0];
        if(parent)await tx.run("UPDATE notebooks SET parentId=? WHERE scopeKey=? AND id=?",[parentId,scope.scopeKey,id]);
      }
    });
  }

  private async pruneWorkspaceSnapshot(scope:ScopeDescriptor,seen:Map<EntityType,Set<string>>):Promise<void>{
    const attachmentIds=[...(seen.get("attachment")||[])];
    const stale=await this.options.db.query<{id:string}>(`SELECT id FROM attachments WHERE scopeKey=?
      ${attachmentIds.length?`AND id NOT IN (${attachmentIds.map(()=>"?").join(",")})`:""}`,[scope.scopeKey,...attachmentIds]);
    await this.options.db.transaction(async(tx)=>{
      const remove=async(table:string,type:EntityType)=>{
        const ids=[...(seen.get(type)||[])];
        await tx.run(`DELETE FROM ${table} WHERE scopeKey=?
          ${ids.length?`AND id NOT IN (${ids.map(()=>"?").join(",")})`:""}
          AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.profileId=? AND o.scopeKey=?
            AND o.entityType=? AND o.entityId=${table}.id AND o.status IN ('pending','inflight','failed'))`,
        [scope.scopeKey,...ids,this.options.profileId,scope.scopeKey,type]);
      };
      const removeComposite=async(table:string,type:EntityType,idSql:string)=>{
        const ids=[...(seen.get(type)||[])];
        await tx.run(`DELETE FROM ${table} WHERE scopeKey=?
          ${ids.length?`AND (${idSql}) NOT IN (${ids.map(()=>"?").join(",")})`:""}
          AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.profileId=? AND o.scopeKey=?
            AND o.entityType=? AND o.entityId=(${idSql}) AND o.status IN ('pending','inflight','failed'))`,
        [scope.scopeKey,...ids,this.options.profileId,scope.scopeKey,type]);
      };
      await remove("attachments","attachment");
      await remove("diaries","diary");
      await remove("mindmaps","mindmap");
      const reminderIds=[...(seen.get("task_reminder")||[])];
      await tx.run(`DELETE FROM task_reminders WHERE taskId IN (SELECT id FROM tasks WHERE scopeKey=?)
        ${reminderIds.length?`AND id NOT IN (${reminderIds.map(()=>"?").join(",")})`:""}
        AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.profileId=? AND o.scopeKey=?
          AND o.entityType='task_reminder' AND o.entityId=task_reminders.id AND o.status IN ('pending','inflight','failed'))`,
      [scope.scopeKey,...reminderIds,this.options.profileId,scope.scopeKey]);
      await remove("tasks","task");
      await removeComposite("favorites","favorite","favorites.userId || ':' || favorites.noteId");
      await removeComposite("note_tags","note_tag","note_tags.noteId || ':' || note_tags.tagId");
      await remove("notes","note");
      await remove("notebooks","notebook");
      await remove("tags","tag");
    });
    await Promise.all(stale.map(({id})=>this.options.attachments.remove(id).catch(()=>undefined)));
  }

  private async push(scope: ScopeDescriptor): Promise<void> {
    const rows = await this.options.db.query<{
      mutationId:string;entityType:EntityType;entityId:string;operation:"upsert"|"delete";
      baseVersion:number|null;payload:string|null;
    }>(`SELECT mutationId,entityType,entityId,operation,baseVersion,payload FROM sync_outbox
      WHERE profileId=? AND scopeKey=? AND status IN ('pending','failed') ORDER BY createdAt LIMIT 100`,
    [this.options.profileId,scope.scopeKey]);
    if (!rows.length || !scope.canWrite && scope.workspaceId) return;
    const mutations = rows.map((row) => ({ ...row,
      baseVersion:row.baseVersion??undefined,payload:row.payload?JSON.parse(row.payload):undefined }));
    const response = await this.request<{ serverSequence:number;results:Array<{mutationId:string;status:string;code?:string;serverVersion?:number;serverPayload?:Record<string,unknown>}> }>(
      `/push?scopeKey=${encodeURIComponent(scope.scopeKey)}`,
      { method:"POST",body:JSON.stringify({scopeKey:scope.scopeKey,deviceId:this.options.deviceId,mutations}) },
    );
    await this.options.db.transaction(async (tx) => {
      for (const result of response.results) {
        const source = rows.find((row) => row.mutationId===result.mutationId);
        if (result.status === "applied" || result.status === "duplicate") {
          await tx.run("DELETE FROM sync_outbox WHERE mutationId=?",[result.mutationId]);
          if (source?.entityType === "attachment" && source.operation === "delete") {
            await this.options.attachments.remove(source.entityId).catch(() => undefined);
          }
        } else if (result.code === "VERSION_CONFLICT" && source) {
          await tx.run(`INSERT INTO sync_conflicts (
            id,profileId,scopeKey,entityType,entityId,localVersion,remoteVersion,
            localPayload,remotePayload,status,createdAt
          ) VALUES (?,?,?,?,?,?,?,?,?,'unresolved',?)`, [
            newLocalId(),this.options.profileId,scope.scopeKey,source.entityType,source.entityId,
            source.baseVersion,result.serverVersion,source.payload,
            JSON.stringify(result.serverPayload||{version:result.serverVersion}),now(),
          ]);
          await tx.run("DELETE FROM sync_outbox WHERE mutationId=?",[result.mutationId]);
        } else {
          await tx.run(`UPDATE sync_outbox SET status='failed',retryCount=retryCount+1,
            lastAttemptAt=?,lastError=? WHERE mutationId=?`,[now(),result.code||"SERVER_ERROR",result.mutationId]);
        }
      }
    });
  }

  private async pull(scope: ScopeDescriptor): Promise<void> {
    const state = (await this.options.db.query<{ lastSequence:number }>(
      "SELECT lastSequence FROM sync_state WHERE profileId=? AND scopeKey=?",
      [this.options.profileId,scope.scopeKey],
    ))[0];
    const after = state?.lastSequence || 0;
    const changes = await this.request<{ resetRequired:boolean;nextSequence:number;items:Array<{entityType:RemoteEntityType;entityId:string;operation:string}> }>(
      `/changes?scopeKey=${encodeURIComponent(scope.scopeKey)}&after=${after}`,
    );
    if (changes.resetRequired) { await this.bootstrap(scope); return; }
    const deletes: SnapshotEntry[] = changes.items.filter((item)=>item.operation==="delete")
      .map((item)=>({entityType:item.entityType,entityId:item.entityId,payload:{__delete:true}}));
    const wanted = new Set(changes.items.filter((item)=>item.operation!=="delete").map((item)=>`${item.entityType}\0${item.entityId}`));
    const entries: SnapshotEntry[] = [];
    if (wanted.size) {
      let cursor: string|null=null;
      do {
        const params = new URLSearchParams({scopeKey:scope.scopeKey,limit:"200"});
        if(cursor) params.set("cursor",cursor);
        const page = await this.request<{nextCursor:string|null;items:SnapshotEntry[]}>(`/snapshot?${params}`);
        for(const item of page.items){const key=`${item.entityType}\0${item.entityId}`;if(wanted.delete(key))entries.push(item);}
        cursor=page.nextCursor;
      } while(cursor&&wanted.size);
    }
    if(wanted.size)throw syncFailure(
      "SERVER_ERROR",
      `Snapshot 未返回 ${wanted.size} 个 Change Feed upsert payload，禁止推进同步游标`,
    );
    await this.applyEntries(scope,[...entries,...deletes],false);
    await this.advance(scope,changes.nextSequence);
  }

  private async advance(scope: ScopeDescriptor, sequence: number): Promise<void> {
    await this.request(`/ack?scopeKey=${encodeURIComponent(scope.scopeKey)}`,{
      method:"POST",body:JSON.stringify({scopeKey:scope.scopeKey,deviceId:this.options.deviceId,sequence}),
    });
    await this.options.db.run(`UPDATE sync_state SET lastSequence=MAX(lastSequence,?),lastSyncAt=?,
      lastError=NULL,accessStatus='active' WHERE profileId=? AND scopeKey=?`,
    [sequence,now(),this.options.profileId,scope.scopeKey]);
  }

  private async applyEntries(scope: ScopeDescriptor, entries: SnapshotEntry[], bootstrap: boolean): Promise<void> {
    const notebookParents=entries.flatMap((entry)=>entry.entityType==="notebook"
      && typeof entry.payload.parentId==="string" ? [[entry.entityId,entry.payload.parentId] as const] : []);
    await this.options.db.transaction(async (tx) => {
      for(const entry of entries){
        if(!isCoreEntityType(entry.entityType))continue;
        const conflict=(await tx.query<{id:string}>(`SELECT id FROM sync_conflicts WHERE
          profileId=? AND scopeKey=? AND entityType=? AND entityId=? AND status='unresolved' LIMIT 1`,
        [this.options.profileId,scope.scopeKey,entry.entityType,entry.entityId]))[0];
        if(conflict&&!entry.payload.__delete){
          await tx.run(`UPDATE sync_conflicts SET remotePayload=?,remoteVersion=COALESCE(?,remoteVersion)
            WHERE id=?`,[JSON.stringify(entry.payload),Number(entry.payload.version)||null,conflict.id]);
          continue;
        }
        const pending=(await tx.query<{payload:string|null}>(`SELECT payload FROM sync_outbox WHERE
          profileId=? AND scopeKey=? AND entityType=? AND entityId=? AND status IN ('pending','failed','inflight') LIMIT 1`,
        [this.options.profileId,scope.scopeKey,entry.entityType,entry.entityId]))[0];
        if(pending&&!entry.payload.__delete){
          const local=await this.readEntity(tx,scope.scopeKey,entry.entityType,entry.entityId);
          if(!bootstrap||stable(local)!==stable(entry.payload)){
            await tx.run(`INSERT INTO sync_conflicts (id,profileId,scopeKey,entityType,entityId,
              localPayload,remotePayload,status,createdAt) VALUES (?,?,?,?,?,?,?,'unresolved',?)`,[
              newLocalId(),this.options.profileId,scope.scopeKey,entry.entityType,entry.entityId,
              pending.payload||JSON.stringify(local),JSON.stringify(entry.payload),now(),
            ]);
            continue;
          }
        }
        await this.applyEntity(tx,scope,entry);
      }
      for(const [id,parentId] of notebookParents){
        const parent=(await tx.query<{id:string}>("SELECT id FROM notebooks WHERE scopeKey=? AND id=?",[scope.scopeKey,parentId]))[0];
        if(parent)await tx.run("UPDATE notebooks SET parentId=? WHERE scopeKey=? AND id=?",[parentId,scope.scopeKey,id]);
      }
    });
  }

  private async readEntity(db:NativeDatabase,scopeKey:string,type:EntityType,id:string):Promise<Record<string,unknown>|null>{
    const table=type==="notebook"?"notebooks":type==="note"?"notes":type==="tag"?"tags":type==="attachment"?"attachments"
      :type==="task"?"tasks":type==="task_reminder"?"task_reminders":type==="diary"?"diaries":type==="mindmap"?"mindmaps":null;
    if(!table)return null;
    if(type==="task_reminder")return (await db.query<Record<string,unknown>>("SELECT * FROM task_reminders WHERE id=?",[id]))[0]||null;
    return (await db.query<Record<string,unknown>>(`SELECT * FROM ${table} WHERE scopeKey=? AND id=?`,[scopeKey,id]))[0]||null;
  }

  private async applyEntity(db:NativeDatabase,scope:ScopeDescriptor,entry:SnapshotEntry):Promise<void>{
    const p=entry.payload;const deleting=Boolean(p.__delete);const key=scope.scopeKey;const ws=scope.workspaceId;
    if(entry.entityType==="note_tag"){
      const [noteId,tagId]=entry.entityId.split(":");
      if(deleting)await db.run("DELETE FROM note_tags WHERE scopeKey=? AND noteId=? AND tagId=?",[key,noteId,tagId]);
      else await db.run("INSERT OR IGNORE INTO note_tags (scopeKey,workspaceId,noteId,tagId,createdAt) VALUES (?,?,?,?,?)",[key,ws,p.noteId||noteId,p.tagId||tagId,now()]);
      return;
    }
    if(entry.entityType==="favorite"){
      const noteId=String(p.noteId||entry.entityId.split(":").at(-1));
      if(deleting)await db.run("DELETE FROM favorites WHERE scopeKey=? AND userId=? AND noteId=?",[key,this.options.userId,noteId]);
      else await db.run("INSERT OR IGNORE INTO favorites (scopeKey,workspaceId,userId,noteId,createdAt) VALUES (?,?,?,?,?)",[key,ws,this.options.userId,noteId,p.createdAt||now()]);
      return;
    }
    if(entry.entityType==="task_reminder"){
      if(deleting){await db.run("DELETE FROM task_reminders WHERE id=?",[entry.entityId]);return;}
      await db.run(`INSERT INTO task_reminders (id,taskId,userId,offsetMinutes,enabled,lastNotifiedAt,snoozedUntil,createdAt,updatedAt)
        VALUES (?,?,?,?,?,NULL,NULL,?,?) ON CONFLICT(id) DO UPDATE SET
        taskId=excluded.taskId,offsetMinutes=excluded.offsetMinutes,enabled=excluded.enabled,updatedAt=excluded.updatedAt`,[
        entry.entityId,p.taskId,this.options.userId,p.offsetMinutes||30,p.enabled===false?0:(p.enabled??1),p.createdAt||now(),now(),
      ]);return;
    }
    if(entry.entityType==="task"){
      if(deleting){await db.run("DELETE FROM tasks WHERE scopeKey=? AND id=?",[key,entry.entityId]);return;}
      await db.run(`INSERT INTO tasks (
        id,scopeKey,workspaceId,userId,title,description,isCompleted,completedAt,priority,dueDate,dueAt,startDate,noteId,parentId,sortOrder,projectId,status,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,description=excluded.description,isCompleted=excluded.isCompleted,completedAt=excluded.completedAt,
        priority=excluded.priority,dueDate=excluded.dueDate,dueAt=excluded.dueAt,startDate=excluded.startDate,noteId=excluded.noteId,
        parentId=excluded.parentId,sortOrder=excluded.sortOrder,projectId=excluded.projectId,status=excluded.status,updatedAt=excluded.updatedAt`,[
        entry.entityId,key,ws,p.userId||this.options.userId,p.title||"新任务",p.description||"",p.isCompleted?1:0,p.completedAt||null,
        p.priority||2,p.dueDate||null,p.dueAt||null,p.startDate||null,p.noteId||null,p.parentId||null,p.sortOrder||0,p.projectId||null,
        p.status||(p.isCompleted?"done":"todo"),p.createdAt||now(),p.updatedAt||now(),
      ]);return;
    }
    if(entry.entityType==="diary"){
      if(deleting){await db.run("DELETE FROM diaries WHERE scopeKey=? AND id=?",[key,entry.entityId]);return;}
      const jsonArray=(value:unknown)=>typeof value==="string"?value:JSON.stringify(Array.isArray(value)?value:[]);
      await db.run(`INSERT INTO diaries (id,scopeKey,workspaceId,userId,contentText,mood,images,media,createdAt)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        contentText=excluded.contentText,mood=excluded.mood,images=excluded.images,media=excluded.media`,[
        entry.entityId,key,ws,p.userId||this.options.userId,p.contentText||"",p.mood||"",jsonArray(p.images),jsonArray(p.media),p.createdAt||now(),
      ]);return;
    }
    if(entry.entityType==="mindmap"){
      if(deleting){await db.run("DELETE FROM mindmaps WHERE scopeKey=? AND id=?",[key,entry.entityId]);return;}
      await db.run(`INSERT INTO mindmaps (id,scopeKey,workspaceId,userId,title,data,starred,folderId,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,data=excluded.data,starred=excluded.starred,folderId=excluded.folderId,updatedAt=excluded.updatedAt`,[
        entry.entityId,key,ws,p.userId||this.options.userId,p.title||"无标题导图",
        typeof p.data==="string"?p.data:JSON.stringify(p.data||{}),p.starred?1:0,p.folderId||null,p.createdAt||now(),p.updatedAt||now(),
      ]);return;
    }
    const table=entry.entityType==="notebook"?"notebooks":entry.entityType==="note"?"notes":entry.entityType==="tag"?"tags":"attachments";
    if(deleting){await db.run(`DELETE FROM ${table} WHERE scopeKey=? AND id=?`,[key,entry.entityId]);return;}
    if(entry.entityType==="notebook"){
      const parentId=typeof p.parentId==="string"&&(await db.query<{id:string}>(
        "SELECT id FROM notebooks WHERE scopeKey=? AND id=?",[key,p.parentId],
      ))[0]?p.parentId:null;
      await db.run(`INSERT INTO notebooks (
      id,scopeKey,workspaceId,userId,parentId,name,description,icon,color,sortOrder,isExpanded,isDeleted,deletedAt,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scopeKey,id) DO UPDATE SET
      parentId=excluded.parentId,name=excluded.name,description=excluded.description,icon=excluded.icon,color=excluded.color,
      sortOrder=excluded.sortOrder,isExpanded=excluded.isExpanded,isDeleted=excluded.isDeleted,deletedAt=excluded.deletedAt,updatedAt=excluded.updatedAt`,[
      entry.entityId,key,ws,p.userId||this.options.userId,parentId,p.name||"未命名笔记本",p.description||null,p.icon||"📒",p.color||null,p.sortOrder||0,p.isExpanded??1,p.isDeleted||0,p.deletedAt||null,p.createdAt||now(),p.updatedAt||now()]);
    }
    else if(entry.entityType==="note")await db.run(`INSERT INTO notes (
      id,scopeKey,workspaceId,userId,notebookId,title,content,contentText,contentFormat,isPinned,isFavorite,isLocked,isArchived,isTrashed,trashedAt,version,sortOrder,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scopeKey,id) DO UPDATE SET
      notebookId=excluded.notebookId,title=excluded.title,content=excluded.content,contentText=excluded.contentText,contentFormat=excluded.contentFormat,
      isPinned=excluded.isPinned,isFavorite=excluded.isFavorite,isLocked=excluded.isLocked,isArchived=excluded.isArchived,isTrashed=excluded.isTrashed,
      trashedAt=excluded.trashedAt,version=excluded.version,sortOrder=excluded.sortOrder,updatedAt=excluded.updatedAt`,[
      entry.entityId,key,ws,p.userId||this.options.userId,p.notebookId,p.title||"无标题笔记",p.content??"{}",p.contentText??"",p.contentFormat||"tiptap-json",p.isPinned||0,p.isFavorite||0,p.isLocked||0,p.isArchived||0,p.isTrashed||0,p.trashedAt||null,p.version||1,p.sortOrder||0,p.createdAt||now(),p.updatedAt||now()]);
    else if(entry.entityType==="tag")await db.run(`INSERT INTO tags (id,scopeKey,workspaceId,userId,name,color,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scopeKey,id) DO UPDATE SET name=excluded.name,color=excluded.color,updatedAt=excluded.updatedAt`,[
      entry.entityId,key,ws,p.userId||this.options.userId,p.name||"未命名标签",p.color||"#58a6ff",p.createdAt||now(),p.updatedAt||now()]);
    else await db.run(`INSERT INTO attachments (
      id,scopeKey,workspaceId,noteId,userId,filename,mimeType,size,localPath,hash,available,transferStatus,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,NULL,?,0,'pending_download',?,?) ON CONFLICT(scopeKey,id) DO UPDATE SET
      filename=excluded.filename,mimeType=excluded.mimeType,size=excluded.size,hash=COALESCE(excluded.hash,attachments.hash),
      transferStatus=CASE WHEN attachments.available=1 THEN attachments.transferStatus ELSE 'pending_download' END,updatedAt=excluded.updatedAt`,[
      entry.entityId,key,ws,p.noteId,p.userId||this.options.userId,p.filename||"attachment",p.mimeType||"application/octet-stream",p.size||0,p.hash||null,p.createdAt||now(),now()]);
  }

  private async transferAttachments(scope:ScopeDescriptor):Promise<void>{
    const rows=await this.options.db.query<{id:string;mimeType:string;size:number;hash:string|null;transferStatus:string}>(`
      SELECT id,mimeType,size,hash,transferStatus FROM attachments WHERE scopeKey=?
        AND transferStatus IN ('pending_upload','failed','pending_download') ORDER BY updatedAt LIMIT 4`,[scope.scopeKey]);
    for(const row of rows){
      const url=`${this.options.serverUrl.replace(/\/+$/,'')}/api/sync/v2/blob/${encodeURIComponent(row.id)}?scopeKey=${encodeURIComponent(scope.scopeKey)}`;
      try{
        if(row.transferStatus==="pending_download"){
          const response=await fetch(url,{headers:{Authorization:`Bearer ${this.options.token}`}});
          if(response.status===409)continue;if(!response.ok)throw new Error(`HTTP ${response.status}`);
          const blob=await response.blob();
          const stored=await this.options.attachments.save({attachmentId:row.id,data:blob,expectedSize:row.size||undefined,expectedHash:row.hash||undefined});
          await this.options.db.run("UPDATE attachments SET localPath=?,hash=?,size=?,available=1,transferStatus='ready',transferError=NULL,updatedAt=? WHERE scopeKey=? AND id=?",[stored.path,stored.sha256,stored.size,now(),scope.scopeKey,row.id]);
          this.options.onAttachmentReady?.(row.id);
        }else{
          const exists=await fetch(url,{method:"HEAD",headers:{Authorization:`Bearer ${this.options.token}`}});
          if(exists.ok){await this.options.db.run("UPDATE attachments SET transferStatus='uploaded',transferError=NULL,updatedAt=? WHERE scopeKey=? AND id=?",[now(),scope.scopeKey,row.id]);continue;}
          const blob=await this.options.attachments.read(row.id,row.mimeType);
          const uploaded=await fetch(url,{method:"PUT",headers:{Authorization:`Bearer ${this.options.token}`,"Content-Type":row.mimeType},body:blob});
          if(!uploaded.ok)throw new Error(`HTTP ${uploaded.status}`);
          await this.options.db.run("UPDATE attachments SET transferStatus='uploaded',transferError=NULL,updatedAt=? WHERE scopeKey=? AND id=?",[now(),scope.scopeKey,row.id]);
        }
      }catch(error){await this.options.db.run("UPDATE attachments SET transferStatus='failed',transferError=?,updatedAt=? WHERE scopeKey=? AND id=?",[error instanceof Error?error.message:"SERVER_ERROR",now(),scope.scopeKey,row.id]);}
    }
  }
}

export function createMobileSyncEngine(options:MobileSyncOptions):MobileSyncEngine{return new MobileSyncEngine(options);}
