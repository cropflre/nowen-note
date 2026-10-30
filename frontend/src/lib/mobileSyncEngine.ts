import { retainedNativeDeletionAttachments } from "./nativeNoteDeletionRecovery";
import { prepareNativeAssetBaseline, sameNativeAssetOrganization, applyNativeAssetMetadata, assertNativeAssetMetadata, nativeAssetBindingKey, NATIVE_ASSET_ENTITY_SET, readNativeAssetMetadata } from "./nativeAssetOrganization";
import type { NativeDatabase } from "./nativeDatabase";
import type { NativeAttachmentStore } from "./nativeAttachmentStore";
import { newLocalId } from "./localRepository";
import { getResolvedApiBaseUrl } from "./serverUrl";
import { fetchWithAuthRefresh, getAccessToken } from "./authSession";
import { SERVER_ENDPOINT_CHANGED_EVENT } from "./serverEndpointState";
import { forgetUnsentLocalNotes } from "./nativeLocalNoteOrigin";
import { notifyMobileSyncStatusChanged, type MobileSyncAppliedDetail } from "./mobileSyncStatus";
import { nativeReceiptKey } from "./mobileNoteSyncReceipt";
import { NATIVE_TASK_REPEAT_FIELDS, nativeTaskRepeatValues } from "./nativeTaskFields";
import { validateEncryptedNoteWrite } from "./encryptedNotes/noteDocument";
import { applyNativePersonalTree, assertNativePersonalTreeEntry, NATIVE_TREE_ENTITY_SET, NATIVE_TREE_PENDING_SUBSCRIPTION, nativeTreeSubscriptionKey, type NativeTreeEntry } from "./nativeKnowledgeTreeSync";
import { nativeTreeMutationPayload, readNativePersonalTreeNode, sameNativeTreePosition, syncNativeNotebookMoveParents, writeNativePersonalTreeMoves } from "./nativePersonalTreeWrites";
import { applyNativeTreeLifecycleProjection, nativeTreeLifecycleKey, nativeTreeLifecycleOverrides, readNativeTreeLifecycleIntents, writeNativePersonalTreeLifecycle } from "./nativePersonalTreeTrash";

type ScopeStatus = "active" | "replan_required" | "access_revoked";
type EntityType = "notebook" | "note" | "tag" | "note_tag" | "favorite" | "attachment"
  | "task" | "task_reminder" | "diary" | "mindmap";
type RemoteEntityType = EntityType | "knowledge_tree_node" | "attachment_organization";

interface ScopeDescriptor {
  taskRecurrenceLifecycle?: string;
  noteDeletionLifecycle?: "trash-before-delete-v1";
  assetOrganization?: string;
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
  beforeSync?: () => Promise<void>;
  onNetworkUnavailable?: () => void;
  onApplied?: (detail: MobileSyncAppliedDetail) => void;
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

/** Fail closed: a same-number remote edit is not proof of a local echo.
 * Only a recorded mutation-specific server ACK may establish provenance. */
export function isAckedOwnNoteEcho(
  remote: Record<string, unknown>,
  local: Record<string, unknown>,
  pending: { payload: string | null; baseVersion?: number | null },
  storedReceipt: string | undefined,
): boolean {
  if (!storedReceipt) return false;
  try {
    const receipt: unknown = JSON.parse(storedReceipt);
    if (!receipt || typeof receipt !== "object") return false;
    const { mutationId, serverVersion } = receipt as { mutationId?: unknown; serverVersion?: unknown };
    const validVersion = (value: unknown): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    if (typeof mutationId !== "string" || !mutationId ||
        !validVersion(serverVersion) || !validVersion(remote.version) ||
        !validVersion(local.version)) return false;
    if (remote.version !== serverVersion || local.version <= serverVersion) return false;
    // A newer queued edit must be based on (or later than) the confirmed
    // version. Missing/older bases might be a genuine concurrent conflict.
    if (!validVersion(pending.baseVersion) || pending.baseVersion < serverVersion) return false;
    const payload: unknown = pending.payload ? JSON.parse(pending.payload) : null;
    return !!payload && typeof payload === "object" &&
      (payload as { version?: unknown }).version === local.version;
  } catch { return false; }
}

function isCoreEntityType(value:unknown):value is EntityType {
  return value === "notebook" || value === "note" || value === "tag"
    || value === "note_tag" || value === "favorite" || value === "attachment"
    || value === "task" || value === "task_reminder" || value === "diary" || value === "mindmap";
}

function syncFailure(code:string,message:string):Error&{code:string}{
  return Object.assign(new Error(message),{code});
}

/** Reject future protocol entities before a mobile cursor or ACK can advance. */
export function assertMobileSyncItems(items:unknown,kind:"snapshot"|"changes",treeSubscription=false,assetSubscription=false):void{
  if(!Array.isArray(items))throw syncFailure("SERVER_ERROR","远端同步条目格式无效");
  for(const item of items){
    if(!item||typeof item!=="object")throw syncFailure("SERVER_ERROR","远端同步条目格式无效");
    const entry=item as Record<string,unknown>;
    if(!isCoreEntityType(entry.entityType) && !(treeSubscription && entry.entityType === "knowledge_tree_node") && !(assetSubscription && entry.entityType === "attachment_organization"))throw syncFailure("SERVER_ERROR",`不支持的同步实体：${String(entry.entityType)}`);
    if(typeof entry.entityId!=="string"||!entry.entityId)throw syncFailure("SERVER_ERROR","远端同步实体 ID 无效");
    if(kind==="changes"&&entry.operation!=="upsert"&&entry.operation!=="delete")
      throw syncFailure("SERVER_ERROR","远端同步操作无效");
    if(kind==="snapshot"&&(!entry.payload||typeof entry.payload!=="object"||Array.isArray(entry.payload)))
      throw syncFailure("SERVER_ERROR","远端同步快照载荷无效");
  }
}

export class MobileSyncEngine {
  private running = false;
  private rerun = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private syncAbort: AbortController | null = null;
  private assetSubscribed = false;
  private treeNegotiated = false;
  private treeSubscribed = false;

  constructor(private readonly options: MobileSyncOptions) {}

  start(): void {
    this.stopped = false;
    this.requestSync(0);
  }

  stop(): void {
    this.stopped = true;
    this.rerun = false;
    this.syncAbort?.abort();
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  requestSync(delayMs = 800): void {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      // 后台调度不能留下未处理的 Promise rejection。同步游标、Outbox 和原笔记
      // 在错误时保持不变；仅记录诊断状态，交给用户重试/网络恢复时再次触发。
      void this.syncOnce().catch((error: unknown) => {
        if (this.stopped) return;
        const code = error && typeof error === "object"
          && "code" in error && typeof error.code === "string"
          ? error.code
          : "SYNC_RUNTIME_ERROR";
        console.error("[mobile-sync] unexpected background sync failure", error);
        void this.options.db.run(
          "UPDATE sync_state SET lastError=? WHERE profileId=?",
          [code, this.options.profileId],
        ).catch((persistError) => {
          console.warn("[mobile-sync] unable to persist failure diagnostics", persistError);
        }).finally(() => {
          if (!this.stopped) notifyMobileSyncStatusChanged();
        });
      });
    }, delayMs);
  }

  async syncOnce(): Promise<void> {
    if (this.stopped) return;
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    this.syncAbort = new AbortController();
    try {
      await this.options.beforeSync?.();
      if (this.stopped) return;
      const scopes = await this.fetchScopes();
      if (this.stopped) return;
      await this.refreshScopes(scopes);
      for (const scope of scopes) {
        if (this.stopped) return;
        const state = (await this.options.db.query<{ accessStatus: ScopeStatus; lastSequence: number }>(
          "SELECT accessStatus,lastSequence FROM sync_state WHERE profileId=? AND scopeKey=?",
          [this.options.profileId, scope.scopeKey],
        ))[0];
        if (state?.accessStatus === "access_revoked") continue;
        try {
          await this.negotiateTree(scope);
          // Replay durable mutation IDs before reconciling a snapshot. After a
          // lost ACK, the server already has our create; bootstrap alone cannot
          // distinguish that state from a competing creation on another device.
          await this.push(scope);
          if (this.stopped) return;
          const treeBinding = !this.hasTreeSubscription(scope) ? true : (await this.options.db.query<{value:string}>(
            "SELECT value FROM native_runtime_meta WHERE key=?", [nativeTreeSubscriptionKey(this.options.profileId)],
          ))[0]?.value === NATIVE_TREE_ENTITY_SET;
          const assetBinding = !this.assetSubscribed || (await this.options.db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?",[nativeAssetBindingKey(this.options.profileId)]))[0]?.value===NATIVE_ASSET_ENTITY_SET;
          if (!state || state.lastSequence === 0 || state.accessStatus === "replan_required" || !treeBinding || !assetBinding) {
            await this.bootstrap(scope);
            if (this.hasTreeSubscription(scope)) await this.push(scope);
          }
          if (this.stopped) return;
          await this.pull(scope);
          if (this.stopped) return;
          await this.transferAttachments(scope);
        } catch (error) {
          if (this.stopped || this.syncAbort.signal.aborted) return;
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
          await this.options.db.run(`UPDATE sync_state SET lastError=?
            WHERE profileId=? AND scopeKey=?`, [code || "NETWORK_UNAVAILABLE",this.options.profileId,scope.scopeKey]);
        }
      }
    } catch (error) {
      if (this.stopped || this.syncAbort.signal.aborted) return;
      // The first /scopes request happens outside the per-scope error handler.
      // Report an expired login rather than silently leaving Native SQLite stale.
      if ((error as { code?: string })?.code === "AUTH_EXPIRED") {
        await this.options.db.run(
          "UPDATE sync_profiles SET authStatus='auth_required',updatedAt=? WHERE id=?",
          [now(), this.options.profileId],
        );
        this.options.onAuthRequired?.();
        notifyMobileSyncStatusChanged();
        return;
      }
      // Proxy and network errors must not discard local notes or pending writes.
      if ((error as { code?: string })?.code !== "NETWORK_UNAVAILABLE") throw error;
    } finally {
      this.running = false;
      this.syncAbort = null;
      if (!this.stopped) notifyMobileSyncStatusChanged();
      if (this.rerun) { this.rerun = false; this.requestSync(0); }
    }
  }

  async resolveLocalConflict(
    conflictId:string,
    resolution:"keep-local"|"keep-remote"|"manual",
    mergedPayload?:Record<string,unknown>,
  ):Promise<void>{
    this.syncAbort?.abort();
    const row=(await this.options.db.query<{
      id:string;scopeKey:string;entityType:RemoteEntityType;entityId:string;
      localVersion:number|null;remoteVersion:number|null;localPayload:string|null;remotePayload:string|null;status:string;
    }>("SELECT * FROM sync_conflicts WHERE id=? AND profileId=?",[conflictId,this.options.profileId]))[0];
    if(!row||row.status==="resolved")return;
    const deletion=row.entityType === "note" && row.localPayload ? JSON.parse(row.localPayload)._deletionRecovery as {note:Record<string,unknown>}|undefined : undefined;
    if(deletion && resolution === "keep-local") {
      const remote=row.remotePayload?JSON.parse(row.remotePayload):null;
      if(!remote || (!remote.__delete && (!Number.isSafeInteger(row.remoteVersion) || Number(row.remoteVersion)<1))) throw new Error("缺少服务器删除基线，恢复副本已保留");
      await this.options.db.transaction(async tx=>{
        await tx.run("DELETE FROM sync_outbox WHERE profileId=? AND scopeKey=? AND entityType='note' AND entityId=?",[this.options.profileId,row.scopeKey,row.entityId]);
        const enqueue=async(operation:string,payload:Record<string,unknown>,base:number|null)=>tx.run(`INSERT INTO sync_outbox
          (id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,baseVersion,payload,status,retryCount,createdAt)
          VALUES(?,?,?,?,?,'note',?,?,?,?,'pending',0,?)`,[newLocalId(),newLocalId(),this.options.profileId,this.options.deviceId,row.scopeKey,row.entityId,operation,base,JSON.stringify(payload),now()]);
        if(!remote.__delete) await enqueue("upsert",{...deletion.note,isTrashed:1,version:Number(row.remoteVersion)+1},row.remoteVersion);
        await enqueue("delete",JSON.parse(row.localPayload!),remote.__delete?null:Number(row.remoteVersion)+1);
        await tx.run("UPDATE sync_conflicts SET status='resolved',resolvedAt=? WHERE id=?",[now(),row.id]);
      });
      this.requestSync(0);return;
    }
    if(row.entityType==="attachment_organization") {
      if(row.scopeKey!=="personal" || resolution==="manual") throw new Error("附件目录冲突请选择本机或服务器位置");
      const remote=row.remotePayload?JSON.parse(row.remotePayload) as Record<string,unknown>:null;
      if(!remote || remote.__delete || (resolution!=="keep-remote" && remote.deleted===1)) throw new Error("远端附件或目录已删除，不能覆盖");
      await this.options.db.transaction(async tx=>{
        const chosen=resolution==="keep-remote"?remote:await readNativeAssetMetadata(tx,row.entityId,this.options.userId)
          ?? (row.localPayload?JSON.parse(row.localPayload) as Record<string,unknown>:null);
        if(!chosen) throw new Error("缺少本机附件整理元数据");
        const payload={...chosen,version:Number(remote.version)+(resolution==="keep-remote"?0:1)};
        await tx.run("DELETE FROM sync_outbox WHERE profileId=? AND entityType='attachment_organization' AND entityId=?",[this.options.profileId,row.entityId]);
        await applyNativeAssetMetadata(tx,[payload],this.options.userId);
        if(resolution!=="keep-remote") await tx.run(`INSERT INTO sync_outbox(id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,baseVersion,payload,status,retryCount,createdAt)
          VALUES (?,?,?,?,'personal','attachment_organization',?,'upsert',?,?,'pending',0,?)`,
        [newLocalId(),newLocalId(),this.options.profileId,this.options.deviceId,row.entityId,remote.version,JSON.stringify(payload),now()]);
        await tx.run("UPDATE sync_conflicts SET status='resolved',resolvedAt=? WHERE id=?",[now(),row.id]);
      });
      this.requestSync(0);return;
    }
    if (row.entityType === "knowledge_tree_node") {
      if (row.scopeKey !== "personal" || resolution === "manual") throw new Error("个人知识树冲突请选择本机或服务器位置");
      const intent=row.localPayload?JSON.parse(row.localPayload) as Record<string,unknown>:null;
      if(intent?.lifecycle) {
        await this.options.db.transaction(async(tx)=>{
          const remote=row.remotePayload?JSON.parse(row.remotePayload) as Record<string,unknown>:null;
          if(!remote || (!remote.__delete && !Array.isArray(remote.lifecycleSubtree))) throw new Error("服务器子树尚未取得，请联网重试同步后处理");
          if(remote.__delete && resolution!=="keep-remote") throw new Error("远端业务资源已删除，请保留本机正文后处理");
          const nodes=remote.__delete?[]:remote.lifecycleSubtree as Record<string,unknown>[];
          const localNodes=await tx.query<{id:string;resourceId:string;resourceType:string}>(`WITH RECURSIVE subtree(id) AS (
            SELECT ? UNION SELECT t.id FROM native_knowledge_tree_nodes t JOIN subtree s ON t.parentId=s.id WHERE t.scopeKey='personal'
          ) SELECT t.id,t.resourceId,t.resourceType FROM native_knowledge_tree_nodes t JOIN subtree s ON t.id=s.id WHERE t.scopeKey='personal'`,[row.entityId]);
          const removed=localNodes.filter((node)=>!nodes.some((remote)=>remote.id===node.id));
          for(const node of removed) {
            const type=node.resourceType==="file"?"attachment":node.resourceType;
            const protectedBody=await tx.query(`SELECT id FROM sync_outbox WHERE profileId=? AND scopeKey='personal'
              AND entityType=? AND entityId=? UNION SELECT id FROM sync_conflicts WHERE profileId=? AND scopeKey='personal'
              AND entityType=? AND entityId=? AND status='unresolved' LIMIT 1`,[this.options.profileId,type,node.resourceId,this.options.profileId,type,node.resourceId]);
            if(protectedBody.length) throw new Error("子节点仍有待同步正文或冲突，请先保留并处理这些内容");
          }
          await tx.run("DELETE FROM sync_outbox WHERE profileId=? AND scopeKey='personal' AND entityType='knowledge_tree_node' AND entityId=?",[this.options.profileId,row.entityId]);
          await tx.run("UPDATE sync_conflicts SET status='resolved',resolvedAt=? WHERE id=?",[now(),row.id]);
          // A node moved outside the remote subtree is retained as a business
          // resource. Only absent navigation rows are removed here; Pull owns
          // authoritative business tombstones and its pending-body protection.
          await applyNativePersonalTree(tx,[...removed.map((node)=>({entityId:node.id,payload:{__delete:true}})),
            ...nodes.map((payload)=>({entityId:String(payload.id),payload}))],this.options.userId,false);
          await applyNativeTreeLifecycleProjection(tx,nodes,this.options.userId);
          if(resolution==="keep-local") {
            // Refresh positions from the conflict, preserving the cached ACL
            // and password flags. Unknown resources gain no new access proof.
            for(const key of ["knowledgeTreeSnapshot:v1:personal:0","knowledgeTreeSnapshot:v1:personal:1"]) {
              const cached=(await tx.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?",[key]))[0];
              if(!cached) continue;
              const proofs=JSON.parse(cached.value) as Record<string,unknown>[];
              await tx.run("UPDATE native_runtime_meta SET value=? WHERE key=?",[JSON.stringify(proofs.map((proof)=>{
                const position=nodes.find((node)=>node.id===proof.id);
                return position?{...proof,parentId:position.parentId,sortOrder:position.sortOrder,isDeleted:position.isDeleted}:proof;
              })),key]);
            }
          }
          if(resolution==="keep-local" && remote.isDeleted!==(intent.lifecycle==="restore"?0:1)) {
            await writeNativePersonalTreeLifecycle(tx,row.entityId,intent.lifecycle==="restore",
              {profileId:this.options.profileId,deviceId:this.options.deviceId,userId:this.options.userId});
          } else if(resolution==="keep-remote") await tx.run("DELETE FROM native_runtime_meta WHERE key=?",[`nativeTreeTrash:${this.options.profileId}:${row.entityId}`]);
        });
        notifyMobileSyncStatusChanged();this.options.onApplied?.({scopeKey:"personal",noteIds:[],deletedNoteIds:[]});this.requestSync(0);
        return;
      }
      await this.options.db.transaction(async (tx) => {
        const remote = row.remotePayload ? JSON.parse(row.remotePayload) as Record<string,unknown> : null;
        const local = await readNativePersonalTreeNode(tx,row.entityId);
        if (!remote || !local || (remote.__delete && resolution !== "keep-remote")) throw new Error("知识树业务资源缺失，无法安全采用该位置");
        assertNativePersonalTreeEntry(row.entityId,remote,this.options.userId);
        if (resolution === "keep-local") {
          // Recheck cached owner/password ancestry, including the latest move
          // made while the conflict was waiting for the user's choice.
          await writeNativePersonalTreeMoves(tx,[{id:row.entityId}],{profileId:this.options.profileId,deviceId:this.options.deviceId,userId:this.options.userId});
        }
        const payload = resolution === "keep-remote" ? remote : local;
        if (resolution === "keep-remote" && remote.__delete) {
          const descendants = await tx.query<{id:string;resourceType:string;resourceId:string}>(`WITH RECURSIVE subtree(id) AS (
            SELECT ? UNION SELECT t.id FROM native_knowledge_tree_nodes t JOIN subtree p ON t.parentId=p.id WHERE t.scopeKey='personal'
          ) SELECT t.id,t.resourceType,t.resourceId FROM native_knowledge_tree_nodes t JOIN subtree s ON t.id=s.id WHERE t.scopeKey='personal'`,[row.entityId]);
          for (const child of descendants) if (child.id !== row.entityId) {
            const entityType = child.resourceType === "file" ? "attachment" : child.resourceType;
            const pending = await tx.query(`SELECT id FROM sync_outbox WHERE profileId=? AND scopeKey='personal'
              AND ((entityType='knowledge_tree_node' AND entityId=?) OR (entityType=? AND entityId=?))
              UNION SELECT id FROM sync_conflicts WHERE profileId=? AND scopeKey='personal' AND status='unresolved'
              AND ((entityType='knowledge_tree_node' AND entityId=?) OR (entityType=? AND entityId=?)) LIMIT 1`,
            [this.options.profileId,child.id,entityType,child.resourceId,this.options.profileId,child.id,entityType,child.resourceId]);
            if (pending.length) throw new Error("子节点仍有待同步修改或冲突，请先保留并处理这些内容");
          }
          await applyNativePersonalTree(tx,descendants.map((child) => ({entityId:child.id,payload:{__delete:true}})),this.options.userId,false);
        } else await applyNativePersonalTree(tx,[{entityId:row.entityId,payload}],this.options.userId,false);
        await syncNativeNotebookMoveParents(tx,[row.entityId]);
        await tx.run(`DELETE FROM sync_outbox WHERE profileId=? AND scopeKey='personal'
          AND entityType='knowledge_tree_node' AND entityId=?`, [this.options.profileId,row.entityId]);
        if (resolution === "keep-local") await tx.run(`INSERT INTO sync_outbox
          (id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,payload,status,retryCount,createdAt)
          VALUES (?,?,?,?,'personal','knowledge_tree_node',?,'upsert',?,'pending',0,?)`,
        [newLocalId(),newLocalId(),this.options.profileId,this.options.deviceId,row.entityId,JSON.stringify(nativeTreeMutationPayload(local,remote)),now()]);
        await tx.run("UPDATE sync_conflicts SET status='resolved',resolvedAt=? WHERE id=?",[now(),conflictId]);
      });
      notifyMobileSyncStatusChanged();
      this.options.onApplied?.({scopeKey:"personal",noteIds:[],deletedNoteIds:[]});
      this.requestSync(0);
      return;
    }
    if(!isCoreEntityType(row.entityType))throw new Error("该冲突类型暂不支持在移动端合并");
    const entityType = row.entityType;
    const parse=(value:string|null)=>value?JSON.parse(value) as Record<string,unknown>:null;
    const selected=resolution==="manual"?mergedPayload:parse(resolution==="keep-remote"?row.remotePayload:row.localPayload);
    if(!selected)throw new Error("缺少可用的冲突内容");
    if(resolution!=="keep-remote"&&parse(row.remotePayload)?.__delete)throw new Error("远端笔记已永久删除，请先另存为新笔记保留本机内容");
    const workspace=workspaceId(row.scopeKey);
    const stored=(await this.options.db.query<{workspaceName:string;role:string;canWrite:number;accessFingerprint:string}>(
      "SELECT workspaceName,role,canWrite,accessFingerprint FROM sync_workspace_scopes WHERE profileId=? AND scopeKey=?",
      [this.options.profileId,row.scopeKey],
    ))[0];
    const scope:ScopeDescriptor={scopeKey:row.scopeKey,workspaceId:workspace,workspaceName:stored?.workspaceName||null,
      role:stored?.role||null,canWrite:workspace?stored?.canWrite===1:true,accessFingerprint:stored?.accessFingerprint||""};
    await this.options.db.transaction(async(tx)=>{
      // The editor can keep saving while the conflict is awaiting a choice.
      // Keep-local must preserve that latest durable edit, not its old snapshot.
      const chosen = resolution === "keep-local"
        ? await this.readEntity(tx, row.scopeKey, entityType, row.entityId) || selected : selected;
      const payload = row.entityType === "note" && resolution !== "keep-remote"
        && typeof row.remoteVersion === "number" && Number.isSafeInteger(row.remoteVersion) && row.remoteVersion > 0
        ? { ...chosen, version: row.remoteVersion + 1 } : chosen;
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
      if(deletion) await tx.run("UPDATE sync_state SET lastSequence=0 WHERE profileId=? AND scopeKey=?",[this.options.profileId,row.scopeKey]);
      await tx.run("UPDATE sync_conflicts SET status='resolved',resolvedAt=? WHERE id=?",[now(),conflictId]);
    });
    this.requestSync(0);
  }

  async forkLocalConflict(conflictId:string,side:"local"|"remote"):Promise<string>{
    const row=(await this.options.db.query<{scopeKey:string;entityId:string;entityType:RemoteEntityType;localPayload:string|null;remotePayload:string|null}>(
      "SELECT scopeKey,entityId,entityType,localPayload,remotePayload FROM sync_conflicts WHERE id=? AND profileId=?",[conflictId,this.options.profileId],
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
    await this.options.db.transaction(async(tx)=>{
      const chosen = side === "local" ? await this.readEntity(tx, row.scopeKey, "note", row.entityId) || payload : payload;
      const next={...chosen,id,workspaceId:workspace,title:`${String(chosen.title||"无标题笔记")}（${side==="local"?"本机":"服务器"}版本）`,version:1};
      await this.applyEntity(tx,scope,{entityType:"note",entityId:id,payload:next});
      await tx.run(`INSERT INTO sync_outbox (
        id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,payload,status,retryCount,createdAt
      ) VALUES (?,?,?,?,?,'note',?,'upsert',?,'pending',0,?)`,[
        newLocalId(),newLocalId(),this.options.profileId,this.options.deviceId,row.scopeKey,id,JSON.stringify(next),now(),
      ]);
    });
    this.requestSync(0);return id;
  }

  private async fetchResponse(path: string, init: RequestInit = {}): Promise<Response> {
    const syncSignal = this.syncAbort?.signal;
    syncSignal?.throwIfAborted();
    // Never send this native profile's queued writes under another login.
    const activeToken = getAccessToken();
    if (activeToken && activeToken !== this.options.token) {
      throw syncFailure("AUTH_SESSION_CHANGED", "登录状态已更新，等待同步引擎重新初始化");
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const endpointChanged = (event: Event) => {
      if ((event as CustomEvent<{ serverUrl: string }>).detail.serverUrl === this.options.serverUrl) cancel();
    };
    const timer = setTimeout(cancel, 15_000);
    let abortRequest = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      abortRequest = () => reject(new DOMException("Aborted", "AbortError"));
      controller.signal.addEventListener("abort", abortRequest, { once: true });
    });
    init.signal?.addEventListener("abort", cancel, { once: true });
    syncSignal?.addEventListener("abort", cancel, { once: true });
    window.addEventListener(SERVER_ENDPOINT_CHANGED_EVENT, endpointChanged);
    if (syncSignal) window.addEventListener("nowen:token-changed", cancel);
    if (init.signal?.aborted) cancel();
    try {
      // Capacitor 的原生 POST/PUT fetch 不消费 AbortSignal；仍须释放同步循环，
      // 迟到的响应不再写本地状态，下一轮沿用原 mutationId/附件 ID 安全重试。
      // Sync V2 and regular notes must share the same authenticated refresh
      // and NodeBao reverse-proxy path resolution.
      const apiBaseUrl = getResolvedApiBaseUrl(this.options.serverUrl);
      return await Promise.race([aborted, fetchWithAuthRefresh(`${apiBaseUrl}/sync/v2${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers || {}),
        },
      }, apiBaseUrl, (input, requestInit) => {
        controller.signal.throwIfAborted();
        return fetch(input, requestInit);
      })]);
    } catch (cause) {
      if (!syncSignal?.aborted) this.options.onNetworkUnavailable?.();
      throw Object.assign(new Error("网络不可用", { cause }), { code: "NETWORK_UNAVAILABLE" });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abortRequest);
      init.signal?.removeEventListener("abort", cancel);
      syncSignal?.removeEventListener("abort", cancel);
      window.removeEventListener(SERVER_ENDPOINT_CHANGED_EVENT, endpointChanged);
      if (syncSignal) window.removeEventListener("nowen:token-changed", cancel);
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const signal = this.syncAbort?.signal;
    const response = await this.fetchResponse(path, init);
    signal?.throwIfAborted();
    const responseToken = getAccessToken();
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { code?: string; error?: string };
      // A reverse proxy may use a different JSON error code for HTTP 401.
      const code = response.status === 401 ? "AUTH_EXPIRED" : (payload.code || "SERVER_ERROR");
      throw Object.assign(new Error(payload.error || code), { code, status: response.status });
    }
    let payload: T;
    try {
      payload = await response.json() as T;
    } catch {
      // NodeBao/reverse proxies sometimes return their HTML login/home page
      // with HTTP 200 for an unrecognized /sync/v2 route. This is not a
      // successful synchronization response; do not advance the local cursor.
      throw syncFailure(
        "SYNC_PROXY_INVALID_RESPONSE",
        "同步接口返回了非 JSON 响应，请检查节点小宝的 API 代理路径与登录状态",
      );
    }
    signal?.throwIfAborted();
    if (getAccessToken() !== responseToken) {
      throw syncFailure("AUTH_SESSION_CHANGED", "登录状态已更新，旧同步响应已隔离");
    }
    return payload;
  }

  private async fetchScopes(): Promise<ScopeDescriptor[]> {
    const payload = await this.request<{ items: ScopeDescriptor[] }>("/scopes");
    if (!Array.isArray(payload?.items)) {
      throw syncFailure("SYNC_PROXY_INVALID_RESPONSE", "同步空间列表格式无效，请检查节点小宝 API 代理路径");
    }
    return payload.items;
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
    const seen=new Map<RemoteEntityType,Set<string>>();
    const notebookParents=new Map<string,string>();
    const tree: NativeTreeEntry[] = [];
    const assets: SnapshotEntry[] = [];
    do {
      const params = this.subscriptionParams(scope, { limit:"200" });
      if (cursor) params.set("cursor",cursor);
      if (sequence) params.set("snapshotSequence",String(sequence));
      const page = await this.request<{ snapshotSequence:number;nextCursor:string|null;items:SnapshotEntry[] }>(`/snapshot?${params}`);
      assertMobileSyncItems(page.items,"snapshot",this.hasTreeSubscription(scope),this.assetSubscribed && !scope.workspaceId);
      if (!sequence) sequence = page.snapshotSequence;
      for(const entry of page.items){
        const ids=seen.get(entry.entityType)||new Set<string>();ids.add(entry.entityId);seen.set(entry.entityType,ids);
        if(entry.entityType==="notebook"&&typeof entry.payload.parentId==="string")notebookParents.set(entry.entityId,entry.payload.parentId);
      }
      tree.push(...page.items.filter((entry) => entry.entityType === "knowledge_tree_node"));
      assets.push(...page.items.filter(entry=>entry.entityType==="attachment_organization"));
      await this.applyEntries(scope,page.items.filter((entry) => entry.entityType !== "knowledge_tree_node" && entry.entityType !== "attachment_organization"),true);
      cursor = page.nextCursor;
    } while (cursor);
    await this.restoreNotebookParents(scope,notebookParents);
    if (this.assetSubscribed && !scope.workspaceId) {
      await this.options.db.transaction(tx=>prepareNativeAssetBaseline(tx,assets.map(entry=>entry.payload),this.options.userId,{profileId:this.options.profileId,deviceId:this.options.deviceId}));
      await this.applyEntries(scope,assets,true);
    }
    if (this.hasTreeSubscription(scope)) await this.options.db.transaction(async (tx) => {
      const protectedTree = (await tx.query(`SELECT entityId FROM sync_outbox WHERE profileId=? AND scopeKey='personal'
        AND entityType='knowledge_tree_node' UNION SELECT entityId FROM sync_conflicts WHERE profileId=? AND scopeKey='personal'
        AND entityType='knowledge_tree_node' AND status='unresolved' LIMIT 1`, [this.options.profileId,this.options.profileId])).length;
      const local = protectedTree ? await tx.query<Record<string,unknown>>(`SELECT id,userId,workspaceId,parentId,nodeType,resourceType,
        resourceId,sortOrder,isDeleted,deletedAt,createdAt,updatedAt FROM native_knowledge_tree_nodes WHERE scopeKey='personal'`) : [];
      // Validate the complete remote graph before reconciling pending local
      // intentions. All three Apply passes belong to this same transaction.
      await applyNativePersonalTree(tx,tree,this.options.userId,true);
      if (protectedTree) {
        await applyNativePersonalTree(tx,local.map((payload) => ({entityId:String(payload.id),payload})),this.options.userId,true);
        const seen = new Set(tree.map((entry) => entry.entityId));
        // A creation committed while pages were in flight cannot appear in
        // that snapshot. Only its original still-pending business mutation
        // proves this; a later update must not mask a remote tombstone.
        const creating = new Set((await tx.query<{id:string}>(`SELECT 'notebook:' || o.entityId AS id FROM sync_outbox o
          JOIN native_runtime_meta m ON m.key='localTreeFolder:personal:' || o.entityId AND m.value=o.mutationId
          WHERE o.profileId=? AND o.scopeKey='personal' AND o.entityType='notebook' AND o.operation='upsert'`,
        [this.options.profileId])).map((row) => row.id));
        await this.applyTreeEntries(tx,[...tree,...local.filter((row) => !seen.has(String(row.id)) && !creating.has(String(row.id)))
          .map((row) => ({entityId:String(row.id),payload:{__delete:true}}))]);
      }
      // Persist the negotiated graph and subscription intent together. A crash
      // after the server's ACK must not allow a silent legacy downgrade.
      await tx.run(`INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`,
      [nativeTreeSubscriptionKey(this.options.profileId),NATIVE_TREE_PENDING_SUBSCRIPTION,now()]);
      if(this.assetSubscribed) await tx.run(`INSERT INTO native_runtime_meta(key,value,updatedAt) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`,[nativeAssetBindingKey(this.options.profileId),"pending:"+NATIVE_ASSET_ENTITY_SET,now()]);
    });
    if(scope.workspaceId)await this.pruneWorkspaceSnapshot(scope,seen);
    await this.advance(scope,sequence,this.hasTreeSubscription(scope));
  }

  private hasTreeSubscription(scope: ScopeDescriptor): boolean {
    return !scope.workspaceId && this.treeSubscribed;
  }

  private async negotiateTree(scope: ScopeDescriptor): Promise<void> {
    if (scope.workspaceId || this.treeNegotiated) return;
    const stored = (await this.options.db.query<{value:string}>(
      "SELECT value FROM native_runtime_meta WHERE key=?", [nativeTreeSubscriptionKey(this.options.profileId)],
    ))[0]?.value;
    const bound = stored === NATIVE_TREE_ENTITY_SET || stored === NATIVE_TREE_PENDING_SUBSCRIPTION;
    const assetStored=(await this.options.db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?",[nativeAssetBindingKey(this.options.profileId)]))[0]?.value;
    if((assetStored===NATIVE_ASSET_ENTITY_SET || assetStored==="pending:"+NATIVE_ASSET_ENTITY_SET) && scope.assetOrganization!=="personal-v1") throw syncFailure("SERVER_ERROR","服务器不支持已绑定的附件目录同步，已保留队列与游标");
    const entitySet=scope.assetOrganization==="personal-v1"?NATIVE_ASSET_ENTITY_SET:NATIVE_TREE_ENTITY_SET;
    const params = new URLSearchParams({scopeKey:scope.scopeKey,entityTypes:entitySet,deviceId:this.options.deviceId});
    let supported = false, lifecycleSupported=false;
    try {
      const plan = await this.request<{entityTypes?:unknown;treeLifecycle?:unknown;assetOrganization?:string}>(`/plan?${params}`);
      lifecycleSupported=plan.treeLifecycle==="personal-folder-v1";
      const types = plan.entityTypes;
      if (types !== undefined && (!Array.isArray(types) || types.some((type) => !entitySet.split(",").includes(type)))) {
        throw syncFailure("SERVER_ERROR","远端实体订阅响应无效");
      }
      supported = Array.isArray(types) && types.length === entitySet.split(",").length && new Set(types).size === entitySet.split(",").length;
      this.assetSubscribed=supported && entitySet===NATIVE_ASSET_ENTITY_SET && plan.assetOrganization==="personal-v1";
      if (entitySet===NATIVE_ASSET_ENTITY_SET && !this.assetSubscribed) throw syncFailure("SERVER_ERROR","附件目录订阅响应缺少能力确认");
      if (Array.isArray(types) && !supported && (types.length !== 10 || new Set(types).size !== 10 || types.includes("knowledge_tree_node"))) {
        throw syncFailure("SERVER_ERROR","远端实体订阅响应不完整");
      }
    } catch (error) {
      // Old servers may reject the new set. Fall back only before this profile
      // has ever bound a tree cursor; never silently downgrade an existing one.
      if ((error as {code?:string}).code !== "INVALID_PAYLOAD") throw error;
    }
    if (!supported && bound) throw syncFailure("UNSUPPORTED_TREE_SUBSCRIPTION","当前服务器不支持已建立的知识树订阅，已保留本地数据与游标");
    if(supported) await this.options.db.run(`INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`,
      [nativeTreeLifecycleKey(this.options.profileId),lifecycleSupported?"personal-folder-v1":"",now()]);
    this.treeSubscribed = supported;
    this.treeNegotiated = true;
  }

  private subscriptionParams(scope: ScopeDescriptor, extra: Record<string,string> = {}): URLSearchParams {
    const params = new URLSearchParams({scopeKey:scope.scopeKey,...extra});
    if (this.hasTreeSubscription(scope)) {
      params.set("entityTypes",this.assetSubscribed?NATIVE_ASSET_ENTITY_SET:NATIVE_TREE_ENTITY_SET);
      params.set("deviceId",this.options.deviceId);
    }
    return params;
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

  private async pruneWorkspaceSnapshot(scope:ScopeDescriptor,seen:Map<RemoteEntityType,Set<string>>):Promise<void>{
    const attachmentIds=[...(seen.get("attachment")||[])];
    const stale=await this.options.db.query<{id:string}>(`SELECT id FROM attachments WHERE scopeKey=?
      ${attachmentIds.length?`AND id NOT IN (${attachmentIds.map(()=>"?").join(",")})`:""}`,[scope.scopeKey,...attachmentIds]);
    await this.options.db.transaction(async(tx)=>{
      const remove=async(table:string,type:EntityType,extra="")=>{
        const ids=[...(seen.get(type)||[])];
        await tx.run(`DELETE FROM ${table} WHERE scopeKey=?
          ${ids.length?`AND id NOT IN (${ids.map(()=>"?").join(",")})`:""}
          AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.profileId=? AND o.scopeKey=?
            AND o.entityType=? AND o.entityId=${table}.id AND o.status IN ('pending','inflight','failed'))
          AND NOT EXISTS (SELECT 1 FROM sync_conflicts c WHERE c.profileId=? AND c.scopeKey=?
            AND c.entityType=? AND c.entityId=${table}.id AND c.status='unresolved') ${extra}`,
        [scope.scopeKey,...ids,this.options.profileId,scope.scopeKey,type,this.options.profileId,scope.scopeKey,type]);
      };
      const removeComposite=async(table:string,type:EntityType,idSql:string)=>{
        const ids=[...(seen.get(type)||[])];
        await tx.run(`DELETE FROM ${table} WHERE scopeKey=?
          ${ids.length?`AND (${idSql}) NOT IN (${ids.map(()=>"?").join(",")})`:""}
          AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.profileId=? AND o.scopeKey=?
            AND o.entityType=? AND o.entityId=(${idSql}) AND o.status IN ('pending','inflight','failed'))
          AND NOT EXISTS (SELECT 1 FROM sync_conflicts c WHERE c.profileId=? AND c.scopeKey=?
            AND c.entityType=? AND c.entityId=(${idSql}) AND c.status='unresolved')`,
        [scope.scopeKey,...ids,this.options.profileId,scope.scopeKey,type,this.options.profileId,scope.scopeKey,type]);
      };
      await remove("attachments","attachment","AND NOT (available=1 AND transferStatus IN ('local','pending_upload','uploading','failed'))");
      await remove("diaries","diary");
      await remove("mindmaps","mindmap");
      const reminderIds=[...(seen.get("task_reminder")||[])];
      await tx.run(`DELETE FROM task_reminders WHERE taskId IN (SELECT id FROM tasks WHERE scopeKey=?)
        ${reminderIds.length?`AND id NOT IN (${reminderIds.map(()=>"?").join(",")})`:""}
        AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.profileId=? AND o.scopeKey=?
          AND o.entityType='task_reminder' AND o.entityId=task_reminders.id AND o.status IN ('pending','inflight','failed'))
        AND NOT EXISTS (SELECT 1 FROM sync_conflicts c WHERE c.profileId=? AND c.scopeKey=?
          AND c.entityType='task_reminder' AND c.entityId=task_reminders.id AND c.status='unresolved')`,
      [scope.scopeKey,...reminderIds,this.options.profileId,scope.scopeKey,this.options.profileId,scope.scopeKey]);
      await remove("tasks","task","AND NOT EXISTS (SELECT 1 FROM task_reminders r WHERE r.taskId=tasks.id)");
      await removeComposite("favorites","favorite","favorites.userId || ':' || favorites.noteId");
      await removeComposite("note_tags","note_tag","note_tags.noteId || ':' || note_tags.tagId");
      await remove("notes","note",`AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.scopeKey=notes.scopeKey AND a.noteId=notes.id)
        AND NOT EXISTS (SELECT 1 FROM note_tags nt WHERE nt.scopeKey=notes.scopeKey AND nt.noteId=notes.id)
        AND NOT EXISTS (SELECT 1 FROM favorites f WHERE f.scopeKey=notes.scopeKey AND f.noteId=notes.id)`);
      await remove("notebooks","notebook",`AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.scopeKey=notebooks.scopeKey AND n.notebookId=notebooks.id)
        AND NOT EXISTS (SELECT 1 FROM notebooks child WHERE child.scopeKey=notebooks.scopeKey AND child.parentId=notebooks.id)`);
      await remove("tags","tag","AND NOT EXISTS (SELECT 1 FROM note_tags nt WHERE nt.scopeKey=tags.scopeKey AND nt.tagId=tags.id)");
    });
    for (const { id } of stale) {
      const retained = await this.options.db.query("SELECT id FROM attachments WHERE scopeKey=? AND id=?", [scope.scopeKey,id]);
      if (!retained.length) await this.options.attachments.remove(id);
    }
  }

  private async push(scope: ScopeDescriptor): Promise<void> {
    const rows = await this.options.db.query<{
      mutationId:string;entityType:RemoteEntityType;entityId:string;operation:"upsert"|"delete";
      baseVersion:number|null;payload:string|null;
    }>(`SELECT mutationId,entityType,entityId,operation,baseVersion,payload FROM sync_outbox
      WHERE profileId=? AND scopeKey=? AND status IN ('pending','failed')
        AND NOT EXISTS (SELECT 1 FROM sync_conflicts c WHERE c.profileId=sync_outbox.profileId
          AND c.scopeKey=sync_outbox.scopeKey AND c.entityType=sync_outbox.entityType
          AND c.entityId=sync_outbox.entityId AND c.status='unresolved')
      ORDER BY createdAt,rowid LIMIT 100`,
    [this.options.profileId,scope.scopeKey]);
    if (!rows.length || !scope.canWrite && scope.workspaceId) return;
    for(const row of rows) if(row.entityType === "note" && row.operation === "delete" && !JSON.parse(row.payload || "{}")._deletionRecovery) {
      await this.options.db.transaction(async tx=>{
        const previous=(await tx.query<{payload:string}>(`SELECT payload FROM sync_outbox
          WHERE profileId=? AND scopeKey=? AND entityType='note' AND entityId=? AND operation='upsert'
            AND rowid<(SELECT rowid FROM sync_outbox WHERE mutationId=?) ORDER BY rowid DESC LIMIT 1`,
          [this.options.profileId,scope.scopeKey,row.entityId,row.mutationId]))[0];
        if(previous?.payload) {
          row.payload=JSON.stringify({...JSON.parse(previous.payload),_deletionRecovery:{note:JSON.parse(previous.payload),attachments:[]}});
          await tx.run("UPDATE sync_outbox SET payload=? WHERE mutationId=? AND profileId=?",[row.payload,row.mutationId,this.options.profileId]);
        }
      });
    }
    // Commit the queued trash stage before sending a terminal delete. A lost ACK replays the same IDs.
    const earlierNotes=new Set<string>();
    for(let i=0;i<rows.length;i++) if(rows[i].entityType==="note") {
      if(rows[i].operation==="delete" && earlierNotes.has(rows[i].entityId)) {rows.splice(i--,1);this.rerun=true;}
      else earlierNotes.add(rows[i].entityId);
    }
    if(rows.some(row=>row.entityType==="note" && row.operation==="delete") && scope.noteDeletionLifecycle!=="trash-before-delete-v1") {
      throw syncFailure("NOTE_DELETION_UPGRADE_REQUIRED","请升级服务器以确认笔记回收站生命周期；删除队列和恢复副本已保留");
    }
    if (rows.some(row => row.entityType === "task" && ["stop","series"].includes(JSON.parse(row.payload || "{}").recurrenceAction)) && scope.taskRecurrenceLifecycle !== "v1") {
      throw syncFailure("SERVER_ERROR","请升级服务器以同步循环任务操作；本机修改已保留");
    }
    if(rows.some((row)=>row.entityType==="knowledge_tree_node" && JSON.parse(row.payload||"{}").lifecycle)) {
      const capability=(await this.options.db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?",[nativeTreeLifecycleKey(this.options.profileId)]))[0];
      if(capability?.value!=="personal-folder-v1") throw syncFailure("SERVER_ERROR","当前服务器不支持已保存的文件夹回收站操作，已保留本机数据");
    }
    for(const row of rows){
      if((!isCoreEntityType(row.entityType) && !(this.hasTreeSubscription(scope) && row.entityType === "knowledge_tree_node") && !(this.assetSubscribed && !scope.workspaceId && row.entityType === "attachment_organization"))||row.operation!=="upsert"&&row.operation!=="delete")
        throw syncFailure("SERVER_ERROR","本地存在当前客户端不支持的同步实体或操作");
    }
    // The server binds the complete subscription only after Snapshot ACK.
    // Business creates can replay first; structural intentions wait for it.
    const binding = this.hasTreeSubscription(scope) && (await this.options.db.query<{value:string}>(
      "SELECT value FROM native_runtime_meta WHERE key=?", [nativeTreeSubscriptionKey(this.options.profileId)],
    ))[0]?.value === NATIVE_TREE_ENTITY_SET;
    if (!binding) {
      for (let i=rows.length-1;i>=0;i--) if (rows[i].entityType === "knowledge_tree_node") rows.splice(i,1);
    }
    const assetBinding=this.assetSubscribed && !scope.workspaceId && (await this.options.db.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?",[nativeAssetBindingKey(this.options.profileId)]))[0]?.value===NATIVE_ASSET_ENTITY_SET;
    if(!assetBinding) for(let i=rows.length-1;i>=0;i--) if(rows[i].entityType==="attachment_organization") rows.splice(i,1);
    // Keep immutable mutation IDs and never let a later edit bypass an earlier
    // conflict in the same HTTP batch. Acknowledging this one rebases the next.
    const assetIdentities=new Set<string>();
    for(let i=0;i<rows.length;i++) if(rows[i].entityType==="attachment_organization") {
      if(assetIdentities.has(rows[i].entityId)) {rows.splice(i--,1);this.rerun=true;}
      else assetIdentities.add(rows[i].entityId);
    }
    rows.sort((a,b)=>Number(a.entityType==="attachment_organization")-Number(b.entityType==="attachment_organization"));
    if (!rows.length) return;
    const mutations = rows.map((row) => ({ ...row,
      baseVersion:row.baseVersion??undefined,payload:row.entityType==="note" && row.operation==="delete" ? undefined : row.payload?JSON.parse(row.payload):undefined }));
    // Acknowledgements rebase all unsent descendants to the confirmed version.
    // The server applies this batch in order, so later note mutations must then
    // use the revision produced by the preceding mutation of the same note.
    const noteVersions = new Map<string, number>();
    for (const mutation of mutations) {
      if (mutation.entityType !== "note" && mutation.entityType !== "attachment_organization") continue;
      if (noteVersions.has(`${mutation.entityType}:${mutation.entityId}`)) mutation.baseVersion = noteVersions.get(`${mutation.entityType}:${mutation.entityId}`);
      if (mutation.operation === "upsert") {
        noteVersions.set(`${mutation.entityType}:${mutation.entityId}`, mutation.baseVersion === undefined
          ? Math.max(1, Number(mutation.payload?.version) || 1) : mutation.baseVersion + 1);
      } else noteVersions.delete(`${mutation.entityType}:${mutation.entityId}`);
    }
    for (const mutation of mutations) if (mutation.entityType === "note" && mutation.operation === "upsert") {
      validateEncryptedNoteWrite(mutation.payload || {});
      const current = await this.readEntity(this.options.db, scope.scopeKey, "note", mutation.entityId);
      if (current) validateEncryptedNoteWrite(mutation.payload || {}, current);
    }
    // 请求即使超时也可能已被服务器接收，不能继续把该笔记当作“确定未同步”。
    const noteIds = rows.filter((row) => row.entityType === "note").map((row) => row.entityId);
    if (noteIds.length) await this.options.db.transaction((tx) => forgetUnsentLocalNotes(tx, scope.scopeKey, noteIds));
    const response = await this.request<{ serverSequence:number;results:Array<{mutationId:string;status:string;code?:string;version?:number;serverVersion?:number;serverPayload?:Record<string,unknown>}> }>(
      `/push?${this.subscriptionParams(scope)}`,
      { method:"POST",body:JSON.stringify({scopeKey:scope.scopeKey,deviceId:this.options.deviceId,mutations}) },
    );
    for (const result of response.results) {
      const source = mutations.find((mutation) => mutation.mutationId === result.mutationId);
      if (!source) throw syncFailure("SERVER_ERROR", "同步 ACK 不属于当前发送批次");
      if ((source.entityType === "note" || source.entityType === "attachment_organization") && source.operation === "upsert"
        && (result.status === "applied" || result.status === "duplicate")
        && !(typeof result.version === "number" && Number.isSafeInteger(result.version) && result.version > 0)) {
        throw syncFailure("SERVER_ERROR", "笔记同步 ACK 缺少有效版本，已保留待发送修改");
      }
      if (source.entityType === "note" && result.code === "VERSION_CONFLICT" && result.serverPayload && !result.serverPayload.__delete) {
        validateEncryptedNoteWrite(result.serverPayload);
        validateEncryptedNoteWrite(result.serverPayload, source.payload);
      }
    }
    const deletedAttachments:Array<{id:string}>=[];
    await this.options.db.transaction(async (tx) => {
      for (const result of response.results) {
        const source = rows.find((row) => row.mutationId===result.mutationId);
        if (result.status === "applied" || result.status === "duplicate") {
          await tx.run("DELETE FROM sync_outbox WHERE mutationId=?",[result.mutationId]);
          if(source?.entityType === "note" && source.operation === "delete") deletedAttachments.push(...(JSON.parse(source.payload || "{}")._deletionRecovery?.attachments || []));
          if (source?.entityType === "note" && source.operation === "upsert") {
            // Edits committed during Push descend from this server revision.
            // Keep their content and calibrate the next batch's base atomically.
            const remaining = await tx.run(`UPDATE sync_outbox SET baseVersion=?
              WHERE profileId=? AND scopeKey=? AND entityType='note' AND entityId=?
                AND status IN ('pending','failed')`, [result.version, this.options.profileId, scope.scopeKey, source.entityId]);
            if (!remaining.changes) await tx.run("UPDATE notes SET version=? WHERE scopeKey=? AND id=?", [result.version, scope.scopeKey, source.entityId]);
            // Persist the mutation-specific ACK atomically with the Outbox removal.
            await tx.run(`INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`, [
              nativeReceiptKey(this.options.profileId, source.entityId),
              JSON.stringify({ mutationId: result.mutationId, serverVersion: result.version }),
              now(),
            ]);
          }
          if(source?.entityType==="attachment_organization") {
            const next=(await tx.query<{mutationId:string}>("SELECT mutationId FROM sync_outbox WHERE profileId=? AND entityType='attachment_organization' AND entityId=? ORDER BY rowid LIMIT 1",[this.options.profileId,source.entityId]))[0];
            if(next) await tx.run("UPDATE sync_outbox SET baseVersion=? WHERE mutationId=?",[result.version,next.mutationId]);
            else await tx.run("UPDATE native_asset_metadata SET version=? WHERE id=? AND userId=?",[result.version,source.entityId,this.options.userId]);
          }
          if (source?.entityType === "attachment" && source.operation === "delete") {
            await this.options.attachments.remove(source.entityId).catch(() => undefined);
          }
        } else if (result.code === "VERSION_CONFLICT" && source) {
          const local = await this.readEntity(tx, scope.scopeKey, source.entityType, source.entityId);
          const lifecycle = source.entityType==="knowledge_tree_node" ? (await readNativeTreeLifecycleIntents(tx,this.options.profileId)).filter((intent)=>intent.id===source.entityId).at(-1) : undefined;
          const terminal=source.entityType === "note" ? (await tx.query<{payload:string}>("SELECT payload FROM sync_outbox WHERE profileId=? AND scopeKey=? AND entityType='note' AND entityId=? AND operation='delete' ORDER BY rowid DESC LIMIT 1",[this.options.profileId,scope.scopeKey,source.entityId]))[0] : undefined;
          const localPayload=terminal?.payload || (lifecycle?JSON.stringify({...lifecycle,sortOrder:local?.sortOrder}):local?JSON.stringify(local):source.payload);
          const existing = (await tx.query<{id:string}>(`SELECT id FROM sync_conflicts WHERE profileId=? AND scopeKey=?
            AND entityType=? AND entityId=? AND status='unresolved' LIMIT 1`,
          [this.options.profileId,scope.scopeKey,source.entityType,source.entityId]))[0];
          if (existing) {
            await tx.run("UPDATE sync_conflicts SET localPayload=?,remotePayload=? WHERE id=?",
              [localPayload,JSON.stringify(result.serverPayload||{version:result.serverVersion}),existing.id]);
            await tx.run("DELETE FROM sync_outbox WHERE mutationId=?",[result.mutationId]);
            continue;
          }
          await tx.run(`INSERT INTO sync_conflicts (
            id,profileId,scopeKey,entityType,entityId,localVersion,remoteVersion,
            localPayload,remotePayload,status,createdAt
          ) VALUES (?,?,?,?,?,?,?,?,?,'unresolved',?)`, [
            newLocalId(),this.options.profileId,scope.scopeKey,source.entityType,source.entityId,
            source.baseVersion,result.serverVersion ?? null,localPayload,
            JSON.stringify(result.serverPayload||{version:result.serverVersion}),now(),
          ]);
          await tx.run("DELETE FROM sync_outbox WHERE mutationId=?",[result.mutationId]);
        } else {
          await tx.run(`UPDATE sync_outbox SET status='failed',retryCount=retryCount+1,
            lastAttemptAt=?,lastError=? WHERE mutationId=?`,[now(),result.code||"SERVER_ERROR",result.mutationId]);
        }
      }
    });
    if (rows.length === 100 && response.results.some((result) => result.status === "applied" || result.status === "duplicate")) this.rerun = true;
    if(deletedAttachments.length) {
      const retained=await retainedNativeDeletionAttachments(this.options.db);
      for(const attachment of deletedAttachments) {
        if(retained.has(attachment.id) || (await this.options.db.query("SELECT id FROM attachments WHERE id=?",[attachment.id])).length) continue;
        await this.options.attachments.remove(attachment.id).catch(()=>undefined);
      }
    }

  }

  private async pull(scope: ScopeDescriptor): Promise<void> {
    const state = (await this.options.db.query<{ lastSequence:number }>(
      "SELECT lastSequence FROM sync_state WHERE profileId=? AND scopeKey=?",
      [this.options.profileId,scope.scopeKey],
    ))[0];
    const after = state?.lastSequence || 0;
    const changes = await this.request<{ resetRequired:boolean;nextSequence:number;items:Array<{entityType:RemoteEntityType;entityId:string;operation:string}> }>(
      `/changes?${this.subscriptionParams(scope,{after:String(after)})}`,
    );
    assertMobileSyncItems(changes.items,"changes",this.hasTreeSubscription(scope),this.assetSubscribed && !scope.workspaceId);
    if (changes.resetRequired) { await this.bootstrap(scope); return; }
    // Snapshot contains current entities, so intermediate upserts of an entity
    // already deleted in this feed page must not be requested.
    const latest = [...new Map(changes.items.map((item) => [`${item.entityType}\0${item.entityId}`, item])).values()];
    const deletes: SnapshotEntry[] = latest.filter((item)=>item.operation==="delete")
      .map((item)=>({entityType:item.entityType,entityId:item.entityId,payload:{__delete:true}}));
    const wanted = new Set(latest.filter((item)=>item.operation!=="delete").map((item)=>`${item.entityType}\0${item.entityId}`));
    const includeFolders=latest.some(item=>item.entityType==="attachment_organization");
    const entries: SnapshotEntry[] = [];
    if (wanted.size) {
      let cursor: string|null=null;
      do {
        const params = this.subscriptionParams(scope,{limit:"200"});
        if(cursor) params.set("cursor",cursor);
        const page = await this.request<{nextCursor:string|null;items:SnapshotEntry[]}>(`/snapshot?${params}`);
        assertMobileSyncItems(page.items,"snapshot",this.hasTreeSubscription(scope),this.assetSubscribed && !scope.workspaceId);
        for(const item of page.items){const key=`${item.entityType}\0${item.entityId}`;if(wanted.delete(key) || includeFolders && item.entityType==="attachment_organization" && item.payload.kind==="folder")entries.push(item);}
        cursor=page.nextCursor;
      } while(cursor&&(wanted.size || includeFolders));
    }
    if(wanted.size)throw syncFailure(
      "SERVER_ERROR",
      `Snapshot 未返回 ${wanted.size} 个 Change Feed upsert payload，禁止推进同步游标`,
    );
    await this.applyEntries(scope,[...entries,...deletes],false);
    await this.advance(scope,changes.nextSequence);
  }

  private async advance(scope: ScopeDescriptor, sequence: number, replaceCursor=false): Promise<void> {
    await this.request(`/ack?${this.subscriptionParams(scope)}`,{
      method:"POST",body:JSON.stringify({scopeKey:scope.scopeKey,deviceId:this.options.deviceId,sequence}),
    });
    await this.options.db.transaction(async (tx) => {
      await tx.run(`UPDATE sync_state SET lastSequence=${replaceCursor ? "?" : "MAX(lastSequence,?)"},lastSyncAt=?,
        lastError=NULL,accessStatus='active' WHERE profileId=? AND scopeKey=?`,
      [sequence,now(),this.options.profileId,scope.scopeKey]);
      if (replaceCursor) await tx.run(`INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`,
      [nativeTreeSubscriptionKey(this.options.profileId),NATIVE_TREE_ENTITY_SET,now()]);
      if(replaceCursor && this.assetSubscribed) await tx.run(`INSERT INTO native_runtime_meta(key,value,updatedAt) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`,[nativeAssetBindingKey(this.options.profileId),NATIVE_ASSET_ENTITY_SET,now()]);
    });
  }

  private async applyEntries(scope: ScopeDescriptor, entries: SnapshotEntry[], bootstrap: boolean): Promise<void> {
    assertMobileSyncItems(entries,"snapshot",this.hasTreeSubscription(scope),this.assetSubscribed && !scope.workspaceId);
    for (const entry of entries) if (entry.entityType === "note" && !entry.payload.__delete) validateEncryptedNoteWrite(entry.payload);
    const treeDeletes = entries.filter((entry) => entry.entityType === "knowledge_tree_node" && entry.payload.__delete);
    if (treeDeletes.length) {
      const held = await this.options.db.transaction(async (tx) => {
        let held = false;
        for(const intent of await readNativeTreeLifecycleIntents(tx,this.options.profileId)) {
          if(!treeDeletes.some((entry)=>(intent.lifecycleNodes as Record<string,unknown>[]).some((node)=>node.id===entry.entityId))) continue;
          held=true;
          const existing=(await tx.query<{id:string}>("SELECT id FROM sync_conflicts WHERE profileId=? AND entityType='knowledge_tree_node' AND entityId=? AND status='unresolved'",[this.options.profileId,intent.id]))[0];
          if(!existing) await tx.run(`INSERT INTO sync_conflicts (id,profileId,scopeKey,entityType,entityId,localPayload,remotePayload,status,createdAt)
            VALUES (?,?,'personal','knowledge_tree_node',?,?,?,'unresolved',?)`,
            [newLocalId(),this.options.profileId,intent.id,JSON.stringify({...intent,sortOrder:(await readNativePersonalTreeNode(tx,String(intent.id)))?.sortOrder}),JSON.stringify({__delete:true}),now()]);
        }
        for (const entry of treeDeletes) {
          const conflict = (await tx.query<{id:string}>(`SELECT id FROM sync_conflicts WHERE profileId=? AND scopeKey='personal'
            AND entityType='knowledge_tree_node' AND entityId=? AND status='unresolved' LIMIT 1`,[this.options.profileId,entry.entityId]))[0];
          const pending = await tx.query(`SELECT id FROM sync_outbox WHERE profileId=? AND scopeKey='personal'
            AND entityType='knowledge_tree_node' AND entityId=? LIMIT 1`,[this.options.profileId,entry.entityId]);
          if (!conflict && !pending.length) continue;
          held = true;
          if (conflict) await tx.run("UPDATE sync_conflicts SET remotePayload=? WHERE id=?",[JSON.stringify(entry.payload),conflict.id]);
          else await tx.run(`INSERT INTO sync_conflicts (id,profileId,scopeKey,entityType,entityId,localPayload,remotePayload,status,createdAt)
            VALUES (?,?,'personal','knowledge_tree_node',?,?,?,'unresolved',?)`,
          [newLocalId(),this.options.profileId,entry.entityId,JSON.stringify(await readNativePersonalTreeNode(tx,entry.entityId)),JSON.stringify(entry.payload),now()]);
        }
        return held;
      });
      // Keep the durable conflict, but apply no business deletion or cursor ACK.
      // A notebook DELETE would otherwise cascade through retained child bodies.
      if (held) throw syncFailure("VERSION_CONFLICT","远端目录已删除，请先在冲突中心处理本机位置和子节点内容");
    }
    const notebookParents=entries.flatMap((entry)=>entry.entityType==="notebook"
      && typeof entry.payload.parentId==="string" ? [[entry.entityId,entry.payload.parentId] as const] : []);
    const applied: SnapshotEntry[] = [];
    await this.options.db.transaction(async (tx) => {
      // 即使远端内容进入冲突中心而未覆盖本地，它的存在也已得到确认。
      await forgetUnsentLocalNotes(tx, scope.scopeKey, entries.filter((entry) => entry.entityType === "note").map((entry) => entry.entityId));
      const assetEntries: Record<string,unknown>[] = [];
      for(const entry of entries){
        if (entry.entityType === "knowledge_tree_node") continue;
        if(entry.entityType==="attachment_organization") assertNativeAssetMetadata(entry.entityId,entry.payload,this.options.userId);
        if (entry.entityType === "note" && !entry.payload.__delete) {
          const current = await this.readEntity(tx, scope.scopeKey, "note", entry.entityId);
          if (current) validateEncryptedNoteWrite(entry.payload, current);
        }
        const conflict=(await tx.query<{id:string}>(`SELECT id FROM sync_conflicts WHERE
          profileId=? AND scopeKey=? AND entityType=? AND entityId=? AND status='unresolved' LIMIT 1`,
        [this.options.profileId,scope.scopeKey,entry.entityType,entry.entityId]))[0];
        if(conflict){
          await tx.run(`UPDATE sync_conflicts SET remotePayload=?,remoteVersion=COALESCE(?,remoteVersion)
            WHERE id=?`,[JSON.stringify(entry.payload),Number(entry.payload.version)||null,conflict.id]);
          continue;
        }
        const pending=(await tx.query<{payload:string|null;baseVersion:number|null}>(`SELECT payload,baseVersion FROM sync_outbox WHERE
          profileId=? AND scopeKey=? AND entityType=? AND entityId=? AND status IN ('pending','failed','inflight') ORDER BY createdAt DESC,rowid DESC LIMIT 1`,
        [this.options.profileId,scope.scopeKey,entry.entityType,entry.entityId]))[0];
        if(pending){
          const local=await this.readEntity(tx,scope.scopeKey,entry.entityType,entry.entityId);
          if (entry.entityType === "note" && local && !entry.payload.__delete) {
            // A previous mutation from THIS profile was already acknowledged,
            // and the pull sees that exact server version while a newer local
            // edit waits in Outbox. This is our own echo, not a true conflict.
            // Keep the newer local body and queued mutation untouched.
            const receipt = (await tx.query<{value:string}>(
              "SELECT value FROM native_runtime_meta WHERE key=? LIMIT 1",
              [nativeReceiptKey(this.options.profileId, entry.entityId)],
            ))[0];
            if (isAckedOwnNoteEcho(entry.payload, local, pending, receipt?.value)) continue;
          }
          if(entry.entityType==="attachment_organization" && (pending.baseVersion===entry.payload.version || local && sameNativeAssetOrganization(local,entry.payload))) continue;
          if(entry.payload.__delete||!bootstrap||stable(local)!==stable(entry.payload)){
            await tx.run(`INSERT INTO sync_conflicts (id,profileId,scopeKey,entityType,entityId,
              localPayload,remotePayload,localVersion,remoteVersion,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?,'unresolved',?)`,[
              newLocalId(),this.options.profileId,scope.scopeKey,entry.entityType,entry.entityId,
              local ? JSON.stringify(local) : pending.payload,JSON.stringify(entry.payload),
              typeof local?.version === "number" ? local.version : null,
              typeof entry.payload.version === "number" ? entry.payload.version : null,now(),
            ]);
            continue;
          }
        }
        if(entry.entityType==="attachment_organization") assetEntries.push(entry.payload);
        else await this.applyEntity(tx,scope,entry);
        applied.push(entry);
      }
      if(assetEntries.length) await applyNativeAssetMetadata(tx,assetEntries,this.options.userId);
      const tree = entries.filter((entry) => entry.entityType === "knowledge_tree_node");
      if (tree.length) {
        await this.applyTreeEntries(tx,tree);
        applied.push(...tree);
      }
      if(scope.scopeKey==="personal") await applyNativeTreeLifecycleProjection(tx,await nativeTreeLifecycleOverrides(tx,this.options.profileId),this.options.userId);
      for(const [id,parentId] of notebookParents){
        const parent=(await tx.query<{id:string}>("SELECT id FROM notebooks WHERE scopeKey=? AND id=?",[scope.scopeKey,parentId]))[0];
        if(parent)await tx.run("UPDATE notebooks SET parentId=? WHERE scopeKey=? AND id=?",[parentId,scope.scopeKey,id]);
      }
    });
    if (applied.length && !this.stopped) this.options.onApplied?.({
      scopeKey: scope.scopeKey,
      noteIds: applied.filter((entry) => entry.entityType === "note" && !entry.payload.__delete).map((entry) => entry.entityId),
      deletedNoteIds: applied.filter((entry) => entry.entityType === "note" && entry.payload.__delete).map((entry) => entry.entityId),
    });
  }

  private async applyTreeEntries(tx: NativeDatabase, entries: NativeTreeEntry[]): Promise<void> {
    const applicable: NativeTreeEntry[] = [];
    const lifecycleNodes=new Set((await nativeTreeLifecycleOverrides(tx,this.options.profileId)).map((node)=>node.id));
    for(let changed=true;changed;) {
      changed=false;
      for(const entry of entries) if(!lifecycleNodes.has(entry.entityId) && lifecycleNodes.has(entry.payload.parentId)) {
        lifecycleNodes.add(entry.entityId);changed=true;
      }
    }
    for (const entry of entries) {
      assertNativePersonalTreeEntry(entry.entityId,entry.payload,this.options.userId);
      // The root mutation compares the complete subtree on Push. Until it is
      // acknowledged, intermediate echoes cannot undo its local descendants.
      if(lifecycleNodes.has(entry.entityId) || lifecycleNodes.has(entry.payload.parentId)) continue;
      const conflict = (await tx.query<{id:string}>(`SELECT id FROM sync_conflicts WHERE profileId=? AND scopeKey='personal'
        AND entityType='knowledge_tree_node' AND entityId=? AND status='unresolved' LIMIT 1`, [this.options.profileId,entry.entityId]))[0];
      if (conflict) {
        await tx.run("UPDATE sync_conflicts SET remotePayload=? WHERE id=?",[JSON.stringify(entry.payload),conflict.id]);
        continue;
      }
      const queuedRows = await tx.query<{payload:string}>(`SELECT payload FROM sync_outbox WHERE profileId=? AND scopeKey='personal'
        AND entityType='knowledge_tree_node' AND entityId=? ORDER BY createdAt,rowid`, [this.options.profileId,entry.entityId]);
      const pending = queuedRows[0];
      if (pending) {
        const local = await readNativePersonalTreeNode(tx,entry.entityId), queued = JSON.parse(pending.payload) as Record<string,unknown>;
        const base = {parentId:queued.baseParentId,sortOrder:queued.baseSortOrder,isDeleted:queued.baseIsDeleted};
        if (!entry.payload.__delete && (sameNativeTreePosition(base,entry.payload) || (local && sameNativeTreePosition(local,entry.payload))
          || queuedRows.some((row) => sameNativeTreePosition(JSON.parse(row.payload) as Record<string,unknown>,entry.payload)))) continue;
        await tx.run(`INSERT INTO sync_conflicts (id,profileId,scopeKey,entityType,entityId,localPayload,remotePayload,status,createdAt)
          VALUES (?,?,'personal','knowledge_tree_node',?,?,?,'unresolved',?)`,
        [newLocalId(),this.options.profileId,entry.entityId,JSON.stringify(local),JSON.stringify(entry.payload),now()]);
        continue;
      }
      applicable.push(entry);
    }
    await applyNativePersonalTree(tx,applicable,this.options.userId,false);
  }

  private async readEntity(db:NativeDatabase,scopeKey:string,type:RemoteEntityType,id:string):Promise<Record<string,unknown>|null>{
    if (type === "attachment_organization") return scopeKey === "personal" ? readNativeAssetMetadata(db,id,this.options.userId) : null;
    if (type === "knowledge_tree_node") return scopeKey === "personal" ? readNativePersonalTreeNode(db,id) : null;
    const table=type==="notebook"?"notebooks":type==="note"?"notes":type==="tag"?"tags":type==="attachment"?"attachments"
      :type==="task"?"tasks":type==="task_reminder"?"task_reminders":type==="diary"?"diaries":type==="mindmap"?"mindmaps":null;
    if(!table)return null;
    if(type==="task_reminder")return (await db.query<Record<string,unknown>>("SELECT * FROM task_reminders WHERE id=?",[id]))[0]||null;
    return (await db.query<Record<string,unknown>>(`SELECT * FROM ${table} WHERE scopeKey=? AND id=?`,[scopeKey,id]))[0]||null;
  }

  private async applyEntity(db:NativeDatabase,scope:ScopeDescriptor,entry:SnapshotEntry):Promise<void>{
    if(entry.entityType==="attachment_organization") return applyNativeAssetMetadata(db,[entry.payload],this.options.userId);
    if (entry.entityType === "knowledge_tree_node") throw syncFailure("SERVER_ERROR","知识树必须通过完整结构 Apply 事务接收");
    const p=entry.payload;const deleting=Boolean(p.__delete);const key=scope.scopeKey;const ws=scope.workspaceId;
    if (entry.entityType === "note" && !deleting) {
      const current = await this.readEntity(db, key, "note", entry.entityId);
      validateEncryptedNoteWrite(p, current || undefined);
    }
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
      if(deleting){
        const task = (await db.query<{repeatGroupId:string|null}>("SELECT repeatGroupId FROM tasks WHERE scopeKey=? AND id=?",[key,entry.entityId]))[0];
        await db.run("INSERT OR IGNORE INTO task_deletion_tombstones(id,userId,workspaceId,repeatGroupId,deletedAt) VALUES(?,?,?,?,?)",[entry.entityId,this.options.userId,ws,task?.repeatGroupId || null,now()]);
        await db.run("DELETE FROM tasks WHERE scopeKey=? AND id=?",[key,entry.entityId]);return;
      }
      if ((await db.query("SELECT id FROM task_deletion_tombstones WHERE id=?",[entry.entityId])).length) return;
      const recurrenceScope = ws ? `workspace:${ws}` : `personal:${this.options.userId}`;
      const groupId = typeof p.repeatGroupId === "string" ? p.repeatGroupId : entry.entityId;
      if (p.recurrenceAction === "stop") await db.run(`INSERT INTO task_recurrence_state(groupId,scopeKey,action,updatedAt) VALUES(?,?,'stop',?)
        ON CONFLICT(groupId,scopeKey) DO UPDATE SET action=CASE WHEN action='series' THEN action ELSE excluded.action END,updatedAt=excluded.updatedAt`,[groupId,recurrenceScope,now()]);
      const lifecycle = (await db.query<{action:string}>("SELECT action FROM task_recurrence_state WHERE groupId=? AND scopeKey=?",[groupId,recurrenceScope]))[0];
      if (lifecycle?.action === "series") return;
      if (lifecycle?.action === "stop") p.repeatRule = "none";
      const current = (await db.query<Record<string, unknown>>("SELECT * FROM tasks WHERE scopeKey=? AND id=?", [key,entry.entityId]))[0] || {};
      const repeat = nativeTaskRepeatValues({ ...current, ...p } as Partial<import("@/types").Task>);
      await db.run(`INSERT INTO tasks (
        id,scopeKey,workspaceId,userId,title,description,isCompleted,completedAt,archivedAt,priority,dueDate,dueAt,startDate,noteId,parentId,sortOrder,projectId,status,createdAt,updatedAt,${NATIVE_TASK_REPEAT_FIELDS.join(",")}
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${NATIVE_TASK_REPEAT_FIELDS.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,description=excluded.description,isCompleted=excluded.isCompleted,completedAt=excluded.completedAt,archivedAt=CASE WHEN ? THEN excluded.archivedAt ELSE tasks.archivedAt END,
        priority=excluded.priority,dueDate=excluded.dueDate,dueAt=excluded.dueAt,startDate=excluded.startDate,noteId=excluded.noteId,
        parentId=excluded.parentId,sortOrder=excluded.sortOrder,projectId=excluded.projectId,status=excluded.status,updatedAt=excluded.updatedAt,${NATIVE_TASK_REPEAT_FIELDS.map(field => `${field}=excluded.${field}`).join(",")}`,[
        entry.entityId,key,ws,p.userId||this.options.userId,p.title||"新任务",p.description??current.description??"",p.isCompleted?1:0,p.completedAt||null,p.archivedAt||null,
        p.priority||2,p.dueDate||null,p.dueAt===undefined?current.dueAt||null:p.dueAt,p.startDate===undefined?current.startDate||null:p.startDate,p.noteId||null,p.parentId||null,p.sortOrder||0,p.projectId===undefined?current.projectId||null:p.projectId,
        p.status||(p.isCompleted?"done":"todo"),p.createdAt||now(),p.updatedAt||now(),...repeat,Object.prototype.hasOwnProperty.call(p,"archivedAt")?1:0,
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
      id,scopeKey,workspaceId,userId,notebookId,title,content,contentText,contentFormat,colorMark,isPinned,isFavorite,isLocked,isArchived,isTrashed,trashedAt,version,sortOrder,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scopeKey,id) DO UPDATE SET
      notebookId=excluded.notebookId,title=excluded.title,content=excluded.content,contentText=excluded.contentText,contentFormat=excluded.contentFormat,colorMark=excluded.colorMark,
      isPinned=excluded.isPinned,isFavorite=excluded.isFavorite,isLocked=excluded.isLocked,isArchived=excluded.isArchived,isTrashed=excluded.isTrashed,
      trashedAt=excluded.trashedAt,version=excluded.version,sortOrder=excluded.sortOrder,updatedAt=excluded.updatedAt`,[
      entry.entityId,key,ws,p.userId||this.options.userId,p.notebookId,p.title||"无标题笔记",p.content??"{}",p.contentText??"",p.contentFormat||"tiptap-json",p.colorMark??null,p.isPinned||0,p.isFavorite||0,p.isLocked||0,p.isArchived||0,p.isTrashed||0,p.trashedAt||null,p.version||1,p.sortOrder||0,p.createdAt||now(),p.updatedAt||now()]);
    else if(entry.entityType==="tag")await db.run(`INSERT INTO tags (id,scopeKey,workspaceId,userId,name,color,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scopeKey,id) DO UPDATE SET name=excluded.name,color=excluded.color,updatedAt=excluded.updatedAt`,[
      entry.entityId,key,ws,p.userId||this.options.userId,p.name||"未命名标签",p.color||"#58a6ff",p.createdAt||now(),p.updatedAt||now()]);
    else await db.run(`INSERT INTO attachments (
      id,scopeKey,workspaceId,noteId,userId,filename,mimeType,size,localPath,hash,available,transferStatus,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,NULL,?,0,'pending_download',?,?) ON CONFLICT(scopeKey,id) DO UPDATE SET
      filename=excluded.filename,mimeType=excluded.mimeType,size=excluded.size,hash=COALESCE(excluded.hash,attachments.hash),
      transferStatus=CASE WHEN attachments.available=1 THEN attachments.transferStatus ELSE 'pending_download' END,updatedAt=excluded.updatedAt`,[
      entry.entityId,key,ws,p.noteId,p.userId||this.options.userId,p.filename||"attachment",p.mimeType||"application/octet-stream",p.size||0,p.hash||null,p.createdAt||now(),now()]);
    if(entry.entityType==="attachment" && key==="personal") {
      const metadata=await readNativeAssetMetadata(db,`file:${entry.entityId}`,this.options.userId);
      if(metadata) await applyNativeAssetMetadata(db,[metadata],this.options.userId);
    }
  }

  private async transferAttachments(scope:ScopeDescriptor):Promise<void>{
    const rows=await this.options.db.query<{id:string;mimeType:string;size:number;hash:string|null;transferStatus:string}>(`
      SELECT id,mimeType,size,hash,transferStatus FROM attachments WHERE scopeKey=?
        AND transferStatus IN ('pending_upload','failed','pending_download') ORDER BY updatedAt LIMIT 4`,[scope.scopeKey]);
    let completed = 0;
    for(const row of rows){
      if(this.stopped)return;
      const path=`/blob/${encodeURIComponent(row.id)}?scopeKey=${encodeURIComponent(scope.scopeKey)}`;
      try{
        if(row.transferStatus==="pending_download"){
          const response=await this.fetchResponse(path);
          if(response.status===409)continue;if(!response.ok)throw new Error(`HTTP ${response.status}`);
          const blob=await response.blob();
          const stored=await this.options.attachments.save({attachmentId:row.id,data:blob,expectedSize:row.size||undefined,expectedHash:row.hash||undefined});
          await this.options.db.run("UPDATE attachments SET localPath=?,hash=?,size=?,available=1,transferStatus='ready',transferError=NULL,updatedAt=? WHERE scopeKey=? AND id=?",[stored.path,stored.sha256,stored.size,now(),scope.scopeKey,row.id]);
          this.options.onAttachmentReady?.(row.id);
        }else{
          const exists=await this.fetchResponse(path,{method:"HEAD"});
          if(exists.ok){await this.options.db.run("UPDATE attachments SET transferStatus='uploaded',transferError=NULL,updatedAt=? WHERE scopeKey=? AND id=?",[now(),scope.scopeKey,row.id]);completed++;continue;}
          const blob=await this.options.attachments.read(row.id,row.mimeType);
          this.syncAbort?.signal.throwIfAborted();
          const uploaded=await this.fetchResponse(path,{method:"PUT",headers:{"Content-Type":row.mimeType},body:blob});
          if(!uploaded.ok)throw new Error(`HTTP ${uploaded.status}`);
          await this.options.db.run("UPDATE attachments SET transferStatus='uploaded',transferError=NULL,updatedAt=? WHERE scopeKey=? AND id=?",[now(),scope.scopeKey,row.id]);
        }
        completed++;
      }catch(error){
        if(this.syncAbort?.signal.aborted)return;
        await this.options.db.run("UPDATE attachments SET transferStatus='failed',transferError=?,updatedAt=? WHERE scopeKey=? AND id=?",[error instanceof Error?error.message:"SERVER_ERROR",now(),scope.scopeKey,row.id]);
      }
    }
    if(rows.length === 4 && completed > 0)this.rerun = true;
  }
}

export function createMobileSyncEngine(options:MobileSyncOptions):MobileSyncEngine{return new MobileSyncEngine(options);}
