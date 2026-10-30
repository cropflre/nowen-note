import { retainedNativeDeletionAttachments } from "./nativeNoteDeletionRecovery";
import type { Note, NoteListItem, Notebook, Tag, Task, Workspace, WorkspaceRole } from "@/types";
import { taskRemovalIds, type TaskRemovalMode } from "./taskRecurrenceRemoval";
import {
  type LocalAttachmentRecord,
  type LocalRepository,
  type NoteQuery,
  type SyncStateView,
  type WriteResult,
} from "./localRepository";
import type { NativeDatabase } from "./nativeDatabase";
import type { NativeAttachmentStore } from "./nativeAttachmentStore";
import { newLocalId } from "./localRepository";
import { unsentLocalNoteKey } from "./nativeLocalNoteOrigin";
import { notifyMobileSyncStatusChanged } from "./mobileSyncStatus";
import { isEncryptedNoteFormat, validateEncryptedNoteWrite } from "./encryptedNotes/noteDocument";
import { ROOT_DOCUMENT_NOTEBOOK_PREFIX } from "./rootDocumentCreatePolicy";
import { listNativePersonalTreeFolderDrafts, listNativePersonalTreeOverrides, writeNativePersonalTreeFolder, writeNativePersonalTreeMoves, type NativeTreeMove } from "./nativePersonalTreeWrites";
import { nativeTreeLifecycleOverrides, writeNativePersonalTreeLifecycle } from "./nativePersonalTreeTrash";

type EntityType = "notebook" | "note" | "tag" | "note_tag" | "favorite" | "attachment" | "task";

const NOTE_LIST_METADATA_COLUMNS = `n.id,n.userId,n.notebookId,n.workspaceId,n.title,n.contentFormat,n.colorMark,
  n.isPinned,n.isFavorite,n.isLocked,n.isArchived,n.isTrashed,n.version,n.sortOrder,n.createdAt,n.updatedAt`;
// Bound previews in SQLite, before the native bridge serializes its query result.
// Bulk AI tags also consume the first 2000 characters from list items.
const NOTE_LIST_COLUMNS = `${NOTE_LIST_METADATA_COLUMNS},substr(n.contentText,1,2000) AS contentText`;

interface NativeRepositoryOptions {
  db: NativeDatabase;
  attachments: NativeAttachmentStore;
  accountId: string;
  userId: string;
  getScopeKey: () => string;
  requestSync?: () => void;
}

interface SyncContext {
  profileId: string;
  deviceId: string;
}

function now(): string {
  return new Date().toISOString();
}

function bool(value: unknown): number {
  return value ? 1 : 0;
}

function workspaceIdFromScope(scopeKey: string): string | null {
  return scopeKey.startsWith("workspace:") ? scopeKey.slice("workspace:".length) : null;
}

function uuid(): string {
  return newLocalId();
}

export class NativeLocalRepository implements LocalRepository {
  readonly notes: LocalRepository["notes"];
  readonly notebooks: LocalRepository["notebooks"];
  readonly tags: LocalRepository["tags"];
  readonly attachments: LocalRepository["attachments"];
  readonly sync: LocalRepository["sync"];

  private readonly db: NativeDatabase;
  private readonly attachmentStore: NativeAttachmentStore;
  private readonly userId: string;
  private readonly getScopeKey: () => string;
  private readonly requestSyncCallback?: () => void;
  private readonly attachmentUrls = new Map<string, string>();

  constructor(options: NativeRepositoryOptions) {
    this.db = options.db;
    this.attachmentStore = options.attachments;
    this.userId = options.userId;
    this.getScopeKey = options.getScopeKey;
    this.requestSyncCallback = options.requestSync;
    this.notes = {
      list: (query) => this.listNotes(query),
      get: (id) => this.getNote(id),
      create: (input) => this.createNote(input),
      update: (id, patch) => this.updateNote(id, patch),
      remove: (id) => this.removeNote(id),
    };
    this.notebooks = {
      list: () => this.listNotebooks(),
      get: (id) => this.getNotebook(id),
      create: (input) => this.createNotebook(input),
      update: (id, patch) => this.updateNotebook(id, patch),
      remove: (id) => this.removeNotebook(id),
    };
    this.tags = {
      list: () => this.listTags(),
      create: (input) => this.createTag(input),
      update: (id, patch) => this.updateTag(id, patch),
      remove: (id) => this.removeTag(id),
      attach: (noteId, tagId) => this.attachTag(noteId, tagId),
      detach: (noteId, tagId) => this.detachTag(noteId, tagId),
    };
    this.attachments = {
      listByNote: (noteId) => this.listAttachments(noteId),
      save: (input) => this.saveAttachment(input),
      resolveUrl: async (id) => {
        const cached = this.attachmentUrls.get(id);
        if (cached) return cached;
        const url = await this.attachmentStore.resolveUrl(id);
        if (url) this.attachmentUrls.set(id, url);
        return url;
      },
      remove: (id) => this.removeAttachment(id),
    };
    this.sync = {
      getState: () => this.getSyncState(),
      requestSync: async () => { this.requestSyncCallback?.(); },
    };
  }

  getCachedAttachmentUrl(id: string): string | null {
    return this.attachmentUrls.get(id) || null;
  }

  async refreshAttachmentUrl(id:string):Promise<void> {
    const url=await this.attachmentStore.resolveUrl(id);
    if(url)this.attachmentUrls.set(id,url);
  }

  async warmAttachmentUrls(): Promise<void> {
    const rows = await this.db.query<{ id: string }>("SELECT id FROM attachments WHERE available=1");
    await Promise.all(rows.map(async ({ id }) => {
      const url = await this.attachmentStore.resolveUrl(id);
      if (url) this.attachmentUrls.set(id, url);
    }));
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const rows = await this.db.query<{
      workspaceId:string;workspaceName:string;role:WorkspaceRole;updatedAt:string;
    }>(`SELECT workspaceId,workspaceName,role,updatedAt FROM sync_workspace_scopes
      WHERE accessStatus<>'access_revoked' ORDER BY workspaceName`);
    return rows.map((row) => ({
      id:row.workspaceId,name:row.workspaceName,description:"",icon:"🏢",ownerId:"",
      createdAt:row.updatedAt,updatedAt:row.updatedAt,role:row.role,
    }));
  }

  async listNotebooksForWorkspace(workspaceId?: string): Promise<Notebook[]> {
    return this.listNotebooks(this.scopeFromWorkspace(workspaceId).scopeKey);
  }

  async listNotesForWorkspace(workspaceId: string | undefined, query: NoteQuery = {}): Promise<NoteListItem[]> {
    return this.listNotes(query, this.scopeFromWorkspace(workspaceId).scopeKey);
  }

  async listTagsForWorkspace(workspaceId?:string):Promise<Tag[]> {
    return this.listTags(this.scopeFromWorkspace(workspaceId).scopeKey);
  }

  async listNotesWithTags(tagIds:string[],workspaceId?:string,limit=500):Promise<NoteListItem[]> {
    const uniqueTagIds=[...new Set(tagIds)];
    if(!uniqueTagIds.length)return this.listNotesForWorkspace(workspaceId,{limit});
    const scopeKey=this.scopeFromWorkspace(workspaceId).scopeKey;
    const placeholders=uniqueTagIds.map(()=>"?").join(",");
    return this.db.query<NoteListItem>(`SELECT ${NOTE_LIST_COLUMNS} FROM notes n JOIN note_tags nt
      ON nt.scopeKey=n.scopeKey AND nt.noteId=n.id
      WHERE n.scopeKey=? AND n.isTrashed=0 AND n.isArchived=0 AND nt.tagId IN (${placeholders})
      GROUP BY n.scopeKey,n.id HAVING COUNT(DISTINCT nt.tagId)=?
      ORDER BY n.isPinned DESC,n.updatedAt DESC LIMIT ?`,[scopeKey,...uniqueTagIds,uniqueTagIds.length,Math.max(1,limit)]);
  }

  async searchNotes(query:string,limit=100):Promise<Array<{
    id:string;title:string;notebookId:string;updatedAt:string;isFavorite:number;isPinned:number;
    snippet:string;userId:string;workspaceId:string|null;matchedField:string;
  }>> {
    const scopeKey=this.scope().scopeKey;
    const needle=`%${query.trim()}%`;
    if(!query.trim())return [];
    const normalized=query.trim().toLocaleLowerCase();
    const rows=await this.db.query<NoteListItem & {snippet:string;matchIndex:number}>(`
      WITH matching_notes AS (
        SELECT ${NOTE_LIST_METADATA_COLUMNS},n.contentText,
          instr(lower(n.contentText),lower(?)) AS matchIndex
        FROM notes n WHERE n.scopeKey=? AND n.isTrashed=0
          AND (n.title LIKE ? OR n.contentText LIKE ?)
        ORDER BY n.updatedAt DESC LIMIT ?
      )
      SELECT ${NOTE_LIST_METADATA_COLUMNS},n.matchIndex,
        CASE WHEN n.matchIndex=0 THEN substr(n.contentText,1,160)
          ELSE substr(n.contentText,MAX(1,n.matchIndex-60),MIN(2000,MIN(60,n.matchIndex-1)+?+100))
        END AS snippet
      FROM matching_notes n ORDER BY n.updatedAt DESC
    `,[query.trim(),scopeKey,needle,needle,Math.max(1,limit),normalized.length]);
    return rows.map((row)=>{
      const titleMatch=row.title.toLocaleLowerCase().includes(normalized);
      return {id:row.id,title:row.title,notebookId:row.notebookId,updatedAt:row.updatedAt,snippet:row.snippet,
        isFavorite:row.isFavorite,isPinned:row.isPinned,userId:row.userId,
        workspaceId:row.workspaceId,matchedField:titleMatch?(row.matchIndex>0?"title+content":"title"):"content"};
    });
  }

  async duplicateNote(id:string):Promise<Note> {
    const source=await this.getNote(id);
    if(!source)throw new Error("笔记不存在");
    const copyId=newLocalId();
    await this.createNote({...source,id:copyId,title:`${source.title}（副本）`,version:1,createdAt:now()});
    for(const tag of source.tags||[])await this.attachTag(copyId,tag.id);
    return (await this.getNote(copyId))!;
  }

  async saveTaskNoteSnapshot(taskId: string, data: { requestId: string; notebookId: string; title: string; description: string }): Promise<Note> {
    const fingerprintBytes = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([taskId,data.notebookId,data.title,data.description])));
    const fingerprint = Array.from(new Uint8Array(fingerprintBytes),(byte) => byte.toString(16).padStart(2,"0")).join("");
    const receiptKey = `taskNoteSnapshot:${data.requestId}`;
    const readReceipt = async (tx: NativeDatabase) => {
      const receipt = (await tx.query<{ value: string }>("SELECT value FROM native_runtime_meta WHERE key=?",[receiptKey]))[0];
      if (!receipt) return null;
      if (receipt.value !== fingerprint) throw new Error("保存请求已用于其他内容，请重新发起");
      const note = await this.getNote(data.requestId,tx,"personal");
      if (!note || note.isTrashed) throw new Error("之前生成的笔记已删除，请重新发起保存");
      return note;
    };
    const validate = async (tx: NativeDatabase) => {
      const task = (await tx.query<{ userId: string }>("SELECT userId FROM tasks WHERE scopeKey='personal' AND id=?",[taskId]))[0];
      const notebook = (await tx.query<{ userId: string; isDeleted: number }>("SELECT userId,isDeleted FROM notebooks WHERE scopeKey='personal' AND id=?",[data.notebookId]))[0];
      if (!task || task.userId !== this.userId || !notebook || notebook.userId !== this.userId || notebook.isDeleted) throw new Error("任务或保存位置不可访问");
    };
    await validate(this.db);
    const existing = await readReceipt(this.db);
    if (existing) return existing;
    const copied: Array<{ id: string; sourceId: string; filename: string; mimeType: string; size: number; localPath: string; hash: string; task: boolean }> = [];
    let content = data.description;
    let committed = false;
    try {
      const taskIds = Array.from(content.matchAll(/\/api\/task-attachments\/([A-Za-z0-9_-]+)/g),(match) => match[1]);
      const hasServerToken = typeof localStorage !== "undefined" && !!localStorage.getItem("nowen-token");
      if (taskIds.length || hasServerToken) {
        const { listTaskAttachments } = await import("./taskAttachmentClient");
        const { fetchWithAuthRefresh, getAccessToken } = await import("./authSession");
        const sources = await listTaskAttachments(taskId).catch((error) => {
          if (!taskIds.length && error?.status === 404) return [];
          throw error;
        });
        if (taskIds.some((id) => !sources.some((source) => source.id === id))) throw new Error("任务附件不存在或尚未同步");
        for (const source of sources) {
          const { getBaseUrl } = await import("./api.impl");
          const response = await fetchWithAuthRefresh(source.url,{headers:{Authorization:`Bearer ${getAccessToken()}`}},getBaseUrl());
          if (!response.ok) throw new Error("任务附件下载失败，请联网后重试");
          const id = newLocalId();
          const saved = await this.attachmentStore.save({attachmentId:id,data:await response.blob(),expectedSize:source.size});
          copied.push({id,sourceId:source.id,filename:source.filename,mimeType:source.mimeType,size:saved.size,localPath:saved.path,hash:saved.sha256,task:true});
        }
      }
      const noteIds = [...new Set(Array.from(content.matchAll(/\/api\/attachments\/([A-Za-z0-9_-]+)/g),(match) => match[1]))];
      for (const sourceId of noteIds) {
        const source = (await this.db.query<{ filename: string; mimeType: string; size: number; hash: string }>(
          "SELECT filename,mimeType,size,hash FROM attachments WHERE scopeKey='personal' AND userId=? AND id=?",[this.userId,sourceId]))[0];
        if (!source) throw new Error("正文附件未保存到本机，请同步后重试");
        const id = newLocalId();
        const saved = await this.attachmentStore.save({attachmentId:id,data:await this.attachmentStore.read(sourceId,source.mimeType),expectedSize:source.size,expectedHash:source.hash || undefined});
        copied.push({id,sourceId,...source,size:saved.size,localPath:saved.path,hash:saved.sha256,task:false});
      }
      for (const attachment of copied) {
        const prefix = attachment.task ? "task-attachments" : "attachments";
        const pattern = new RegExp(`(?:https?:\\/\\/[^/\\s"'<>]+)?/api/${prefix}/${attachment.sourceId}(?:\\?[^\\s"'<>)]*)?`,"g");
        const referenced = content.includes(`/api/${prefix}/${attachment.sourceId}`);
        content = content.replace(pattern,`/api/attachments/${attachment.id}`);
        if (!referenced) content += `\n\n[${attachment.filename.replace(/[\\[\]]/g,"\\$&")}](/api/attachments/${attachment.id})`;
      }
      let usedCopies = false;
      const note = await this.db.transaction(async (tx) => {
        await validate(tx);
        const duplicate = await readReceipt(tx);
        if (duplicate) return duplicate;
        const saved = await this.insertNote(tx,{id:data.requestId,notebookId:data.notebookId,workspaceId:null,title:data.title,content,contentText:content,contentFormat:"markdown"},true);
        await tx.run("INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,?)",[receiptKey,fingerprint,saved.savedAt]);
        await tx.run("INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,?)",[`localTreeDraft:personal:${data.requestId}`,JSON.stringify(`notebook:${data.notebookId}`),saved.savedAt]);
        for (const attachment of copied) {
          const row = {id:attachment.id,scopeKey:"personal",workspaceId:null,noteId:data.requestId,userId:this.userId,
            filename:attachment.filename,mimeType:attachment.mimeType,size:attachment.size,localPath:attachment.localPath,hash:attachment.hash,
            available:1,transferStatus:"pending_upload" as const,createdAt:saved.savedAt,updatedAt:saved.savedAt};
          await tx.run(`INSERT INTO attachments (id,scopeKey,workspaceId,noteId,userId,filename,mimeType,size,localPath,hash,available,transferStatus,createdAt,updatedAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,Object.values(row));
          await this.enqueue(tx,"attachment",attachment.id,"upsert",row,undefined,"personal");
        }
        usedCopies = true;
        return (await this.getNote(data.requestId,tx,"personal"))!;
      });
      committed = true;
      if (!usedCopies) await Promise.all(copied.map((attachment) => this.attachmentStore.remove(attachment.id)));
      notifyMobileSyncStatusChanged();
      this.requestSyncCallback?.();
      return note;
    } catch (error) {
      if (!committed) await Promise.allSettled(copied.map((attachment) => this.attachmentStore.remove(attachment.id)));
      throw error;
    }
  }

  async archiveTaskTree(id: string, archived = true): Promise<{ success: boolean; affected: number }> {
    const affected = await this.db.transaction(async (tx) => {
      const tasks = await tx.query<{ id: string; parentId: string | null; userId: string; isCompleted: number; archivedAt: string | null; updatedAt: string }>("SELECT * FROM tasks WHERE scopeKey='personal'");
      const root = tasks.find((task) => task.id === id);
      if (!root || root.userId !== this.userId || root.parentId) throw new Error("请从顶层任务归档或恢复");
      const ids = new Set([id]);
      const children = new Map<string,string[]>();
      for (const task of tasks) if (task.parentId) {
        const siblings = children.get(task.parentId) || [];siblings.push(task.id);children.set(task.parentId,siblings);
      }
      const pendingIds = [id];
      while (pendingIds.length) {
        for (const child of children.get(pendingIds.pop()!) || []) if (!ids.has(child)) { ids.add(child);pendingIds.push(child); }
      }
      const tree = tasks.filter((task) => ids.has(task.id));
      if (tree.some((task) => task.userId !== this.userId)) throw new Error("任务树的账户归属不一致");
      if (archived && tree.some((task) => !task.isCompleted)) throw new Error("仍有未完成任务，请完成整棵任务树后再归档");
      const archivedAt = archived ? (root.archivedAt || now()) : null;
      const sync = await this.syncContext(tx);
      for (const task of tree) {
        if ((task.archivedAt || null) === archivedAt) continue;
        const updatedAt = now();
        await tx.run("UPDATE tasks SET archivedAt=?,updatedAt=? WHERE scopeKey='personal' AND id=?",[archivedAt,updatedAt,task.id]);
        const pending = sync ? await tx.query<{ id: string; payload: string }>(`SELECT id,payload FROM sync_outbox
          WHERE profileId=? AND scopeKey='personal' AND entityType='task' AND entityId=? AND operation='upsert'
            AND status='pending' AND retryCount=0 AND lastAttemptAt IS NULL ORDER BY createdAt,rowid`,[sync.profileId,task.id]) : [];
        if (pending.length) {
          const baseline = JSON.parse(pending[0].payload || "{}").baseUpdatedAt;
          await tx.run("UPDATE sync_outbox SET payload=? WHERE id=?",[JSON.stringify({...task,archivedAt,updatedAt,baseUpdatedAt:baseline}),pending[0].id]);
          for (const obsolete of pending.slice(1)) await tx.run("DELETE FROM sync_outbox WHERE id=?",[obsolete.id]);
        } else await this.enqueue(tx,"task",task.id,"upsert",{...task,archivedAt,updatedAt,baseUpdatedAt:task.updatedAt},undefined,"personal");
      }
      return tree.length;
    });
    this.requestSyncCallback?.();
    return {success:true,affected};
  }

  async removeTaskOccurrences(id: string, mode: TaskRemovalMode): Promise<{ success: boolean; affected: number }> {
    const affected = await this.db.transaction(async tx => {
      const tasks = await tx.query<Task>("SELECT * FROM tasks WHERE scopeKey='personal'");
      const root = tasks.find(task => task.id === id);
      if (!root || root.userId !== this.userId) throw new Error("任务不存在或无权操作");
      const ids = taskRemovalIds(tasks,id,mode);
      const rows = tasks.filter(task => ids.has(task.id));
      if (rows.some(task => task.userId !== this.userId)) throw new Error("任务树的账户归属不一致");
      const groupId = root.repeatGroupId || root.id;
      if (mode !== "single") await tx.run(`INSERT INTO task_recurrence_state(groupId,scopeKey,action,updatedAt) VALUES(?,?,?,?)
        ON CONFLICT(groupId,scopeKey) DO UPDATE SET action=CASE WHEN action='series' THEN action ELSE excluded.action END,updatedAt=excluded.updatedAt`,[groupId,`personal:${this.userId}`,mode,now()]);
      if (mode === "stop") {
        for (const task of rows) await tx.run("UPDATE tasks SET repeatRule='none',repeatEndDate=NULL,repeatEndCount=NULL,repeatRuleJson=NULL,repeatGroupId=?,updatedAt=? WHERE id=?",[groupId,now(),task.id]);
        // A series command also stops occurrences created on another device while this one was offline.
        await this.enqueue(tx,"task",id,"upsert",{recurrenceAction:"stop"},undefined,"personal",false);
      } else {
        const dependencies = await tx.query("SELECT name FROM sqlite_master WHERE type='table' AND name='mobile_local_task_dependencies'");
        for (const task of rows) {
          if (dependencies.length) await tx.run("DELETE FROM mobile_local_task_dependencies WHERE predecessorTaskId=? OR successorTaskId=?",[task.id,task.id]);
          await tx.run("INSERT OR REPLACE INTO task_deletion_tombstones(id,userId,workspaceId,repeatGroupId,deletedAt) VALUES(?,?,?,?,?)",[task.id,task.userId,task.workspaceId,task.repeatGroupId || null,now()]);
          await tx.run("DELETE FROM tasks WHERE id=?",[task.id]);
          const inSeries = task.id === groupId || task.repeatGroupId === groupId;
          await this.enqueue(tx,"task",task.id,"delete",{recurrenceAction:mode === "series" && inSeries ? "series" : "single",repeatGroupId:task.repeatGroupId || task.id},undefined,"personal",false);
        }
      }
      return rows.length;
    });
    this.requestSyncCallback?.();
    return {success:true,affected};
  }

  async reorderNotes(items:Array<{id:string;sortOrder:number}>):Promise<void> {
    for(const item of items)await this.updateNote(item.id,{sortOrder:item.sortOrder});
  }

  async reorderNotebooks(items:Array<{id:string;sortOrder:number}>):Promise<void> {
    for(const item of items)await this.updateNotebook(item.id,{sortOrder:item.sortOrder});
  }

  async trashSummary():Promise<{count:number;skipped:number}> {
    const scopeKey=this.scope().scopeKey;
    const count=(await this.db.query<{count:number}>("SELECT COUNT(*) AS count FROM notes WHERE scopeKey=? AND isTrashed=1",[scopeKey]))[0]?.count||0;
    return {count,skipped:0};
  }

  async emptyTrash():Promise<{success:boolean;count:number;skipped:number;noteIds:string[];removedFiles:number}> {
    const scopeKey=this.scope().scopeKey;
    await this.assertWritable(scopeKey);
    const notes=await this.db.query<{id:string;version:number}>("SELECT id,version FROM notes WHERE scopeKey=? AND isTrashed=1",[scopeKey]);
    const attachments=await this.db.query<{id:string}>(`SELECT a.id FROM attachments a JOIN notes n
      ON n.scopeKey=a.scopeKey AND n.id=a.noteId WHERE n.scopeKey=? AND n.isTrashed=1`,[scopeKey]);
    let syncEnabled=false;
    await this.db.transaction(async(tx)=>{
      syncEnabled=Boolean(await this.syncContext(tx));
      for(const note of notes){
        const latest=await this.getNote(note.id,tx,scopeKey);
        if(latest) await this.deleteTrashedNote(tx,latest,scopeKey);
      }
    });
    if (notes.length) notifyMobileSyncStatusChanged();
    if(!syncEnabled) {
      const retained=await retainedNativeDeletionAttachments(this.db);
      await Promise.all(attachments.filter(({id})=>!retained.has(id)).map(({id})=>this.attachmentStore.remove(id).catch(()=>undefined)));
    }
    for(const {id} of attachments)this.attachmentUrls.delete(id);
    return {success:true,count:notes.length,skipped:0,noteIds:notes.map(({id})=>id),removedFiles:syncEnabled?0:attachments.length};
  }

  private scope(): { scopeKey: string; workspaceId: string | null } {
    return this.scopeFromWorkspace(this.getScopeKey());
  }

  private scopeFromWorkspace(raw?: string | null): { scopeKey: string; workspaceId: string | null } {
    const scopeKey = raw && raw !== "personal" ? `workspace:${raw.replace(/^workspace:/, "")}` : "personal";
    return { scopeKey, workspaceId: workspaceIdFromScope(scopeKey) };
  }

  private async assertWritable(scopeKey:string, db:NativeDatabase=this.db):Promise<void> {
    if(scopeKey === "personal") return;
    const scope=(await db.query<{canWrite:number;accessStatus:string}>(
      "SELECT canWrite,accessStatus FROM sync_workspace_scopes WHERE scopeKey=? LIMIT 1",[scopeKey],
    ))[0];
    if(!scope || scope.canWrite !== 1 || scope.accessStatus !== "active") {
      throw new Error("当前工作区为只读或访问权已撤销，修改未写入");
    }
  }

  private async syncContext(tx: NativeDatabase): Promise<SyncContext | null> {
    const rows = await tx.query<SyncContext>(`
      SELECT p.id AS profileId, d.deviceId
      FROM sync_profiles p JOIN sync_devices d ON d.profileId = p.id
      WHERE p.remoteUserId = ?
      ORDER BY p.enabled DESC, p.updatedAt DESC, d.createdAt LIMIT 1
    `, [this.userId]);
    return rows[0] || null;
  }

  private async enqueue(
    tx: NativeDatabase,
    entityType: EntityType,
    entityId: string,
    operation: "upsert" | "delete",
    payload?: Record<string, unknown>,
    baseVersion?: number | null,
    scopeKeyOverride?:string,
    notify = true,
  ): Promise<void> {
    const sync = await this.syncContext(tx);
    if (!sync) return;
    const scopeKey=scopeKeyOverride || this.scope().scopeKey;
    await tx.run(`
      INSERT INTO sync_outbox (
        id, mutationId, profileId, deviceId, scopeKey, entityType, entityId,
        operation, baseVersion, payload, status, retryCount, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `, [
      uuid(), uuid(), sync.profileId, sync.deviceId, scopeKey, entityType, entityId,
      operation, baseVersion ?? null, payload ? JSON.stringify(payload) : null, now(),
    ]);
    if (notify) this.requestSyncCallback?.();
  }

  async movePersonalTreeNodes(items: NativeTreeMove[]) {
    const nodes = await this.db.transaction(async (tx) => {
      const sync = await this.syncContext(tx);
      if (!sync) throw Object.assign(new Error("个人目录同步订阅尚未确认"), { code: "NATIVE_TREE_WRITE_UNAVAILABLE" });
      return writeNativePersonalTreeMoves(tx,items,{ ...sync,userId:this.userId });
    });
    this.requestSyncCallback?.();
    notifyMobileSyncStatusChanged();
    return nodes;
  }

  async listPersonalTreeOverrides(): Promise<Array<Record<string,unknown>>> {
    const sync = await this.syncContext(this.db);
    return sync ? [...await listNativePersonalTreeOverrides(this.db,sync.profileId),
      ...(await nativeTreeLifecycleOverrides(this.db,sync.profileId)).map((node)=>({...node,localLifecycle:node.isDeleted===0?"restore":"trash"}))] : [];
  }

  private async changePersonalTreeTrash(ids:string[],restoring:boolean) {
    const affected=await this.db.transaction(async(tx)=>{
      const sync=await this.syncContext(tx);
      if(!sync) throw Object.assign(new Error("个人目录同步订阅尚未确认"),{code:"NATIVE_TREE_WRITE_UNAVAILABLE"});
      const result=new Set<string>();
      const selected=new Set(ids),parents=new Map((await tx.query<{id:string;parentId:string|null}>("SELECT id,parentId FROM native_knowledge_tree_nodes WHERE scopeKey='personal'")).map((node)=>[node.id,node.parentId]));
      const roots=[...selected].filter((id)=>{
        const seen=new Set([id]);
        for(let parent=parents.get(id);parent && !seen.has(parent);parent=parents.get(parent)) {
          if(selected.has(parent)) return false;seen.add(parent);
        }
        return true;
      });
      for(const id of roots) {
        if(result.has(id)) continue;
        for(const nodeId of await writeNativePersonalTreeLifecycle(tx,id,restoring,{...sync,userId:this.userId})) result.add(nodeId);
      }
      return [...result];
    });
    this.requestSyncCallback?.(); notifyMobileSyncStatusChanged();
    return affected;
  }

  async trashPersonalTreeFolders(ids:string[]) {
    return {success:true as const,mode:"subtree" as const,affectedNodeIds:await this.changePersonalTreeTrash(ids,false),promotedNodeIds:[] as string[]};
  }

  async restorePersonalTreeFolder(id:string) {
    return {success:true as const,restoredNodeIds:await this.changePersonalTreeTrash([id],true)};
  }

  async createPersonalTreeFolder(id: string, title: string, parentId: string | null) {
    const node = await this.db.transaction(async (tx) => {
      const sync = await this.syncContext(tx);
      if (!sync) throw Object.assign(new Error("个人目录同步订阅尚未确认"), {code:"NATIVE_TREE_WRITE_UNAVAILABLE"});
      return writeNativePersonalTreeFolder(tx,id,title,parentId,{...sync,userId:this.userId},
        (row) => this.enqueue(tx,"notebook",id,"upsert",row,undefined,"personal"));
    });
    this.requestSyncCallback?.();
    notifyMobileSyncStatusChanged();
    return node;
  }

  async listPersonalTreeFolderDrafts(includeDeleted=false) {
    return listNativePersonalTreeFolderDrafts(this.db,this.userId,includeDeleted);
  }

  async exportWorkspaceScope(scopeKey:string):Promise<Record<string,unknown>> {
    return {
      format:"nowen-native-workspace-recovery-v1",scopeKey,exportedAt:now(),
      notebooks:await this.db.query("SELECT * FROM notebooks WHERE scopeKey=?",[scopeKey]),
      notes:await this.db.query("SELECT * FROM notes WHERE scopeKey=?",[scopeKey]),
      tags:await this.db.query("SELECT * FROM tags WHERE scopeKey=?",[scopeKey]),
      noteTags:await this.db.query("SELECT * FROM note_tags WHERE scopeKey=?",[scopeKey]),
      favorites:await this.db.query("SELECT * FROM favorites WHERE scopeKey=?",[scopeKey]),
      attachments:await this.db.query("SELECT * FROM attachments WHERE scopeKey=?",[scopeKey]),
    };
  }

  async copyWorkspaceScopeToPersonal(scopeKey:string):Promise<{notebooks:number;notes:number;attachments:number;tasks:number}> {
    if(!scopeKey.startsWith("workspace:"))throw new Error("只能复制工作区 Scope");
    const notebooks=await this.db.query<Record<string,unknown>>("SELECT * FROM notebooks WHERE scopeKey=? ORDER BY parentId IS NOT NULL,createdAt",[scopeKey]);
    const notes=await this.db.query<Record<string,unknown>>("SELECT * FROM notes WHERE scopeKey=? ORDER BY createdAt",[scopeKey]);
    const tags=await this.db.query<Record<string,unknown>>("SELECT * FROM tags WHERE scopeKey=? ORDER BY createdAt",[scopeKey]);
    const noteTags=await this.db.query<{noteId:string;tagId:string}>("SELECT noteId,tagId FROM note_tags WHERE scopeKey=?",[scopeKey]);
    const attachments=await this.db.query<Record<string,unknown>>("SELECT * FROM attachments WHERE scopeKey=? AND available=1",[scopeKey]);
    const notebookMap=new Map(notebooks.map((row)=>[String(row.id),newLocalId()]));
    const noteMap=new Map(notes.map((row)=>[String(row.id),newLocalId()]));
    const tagMap=new Map(tags.map((row)=>[String(row.id),newLocalId()]));
    const attachmentMap=new Map<string,{id:string;path:string;hash:string;size:number}>();
    for(const row of attachments){
      const id=newLocalId();
      try{
        const blob=await this.attachmentStore.read(String(row.id),String(row.mimeType||"application/octet-stream"));
        const stored=await this.attachmentStore.save({attachmentId:id,data:blob});
        attachmentMap.set(String(row.id),{id,path:stored.path,hash:stored.sha256,size:stored.size});
      }catch{/* 缺失二进制的附件不复制，导出仍可保留其元数据 */}
    }
    await this.db.transaction(async(tx)=>{
      for(const row of notebooks){
        const id=notebookMap.get(String(row.id))!;const createdAt=now();
        const payload: Record<string, unknown> & { id: string }={...row,id,scopeKey:"personal",workspaceId:null,userId:this.userId,
          parentId:row.parentId?notebookMap.get(String(row.parentId))||null:null,
          name:`${String(row.name||"工作区副本")}（本地副本）`,createdAt,updatedAt:createdAt};
        await tx.run(`INSERT INTO notebooks (id,scopeKey,workspaceId,userId,parentId,name,description,icon,color,sortOrder,isExpanded,isDeleted,deletedAt,createdAt,updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[payload.id,payload.scopeKey,payload.workspaceId,payload.userId,payload.parentId,payload.name,row.description,row.icon,row.color,row.sortOrder,row.isExpanded,0,null,createdAt,createdAt]);
        await this.enqueue(tx,"notebook",id,"upsert",payload,undefined,"personal");
      }
      for(const row of tags){
        const id=tagMap.get(String(row.id))!;const createdAt=now();
        const payload: Record<string, unknown> & { id: string }={...row,id,scopeKey:"personal",workspaceId:null,userId:this.userId,name:`${String(row.name||"标签")}（副本 ${id.slice(0,6)}）`,createdAt,updatedAt:createdAt};
        await tx.run("INSERT INTO tags (id,scopeKey,workspaceId,userId,name,color,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)",[id,"personal",null,this.userId,payload.name,payload.color,createdAt,createdAt]);
        await this.enqueue(tx,"tag",id,"upsert",payload,undefined,"personal");
      }
      for(const row of notes){
        const id=noteMap.get(String(row.id))!;const notebookId=notebookMap.get(String(row.notebookId));if(!notebookId)continue;const createdAt=now();
        const payload: Record<string, unknown> & { id: string }={...row,id,scopeKey:"personal",workspaceId:null,userId:this.userId,notebookId,title:`${String(row.title||"无标题笔记")}（工作区副本）`,version:1,createdAt,updatedAt:createdAt};
        await tx.run(`INSERT INTO notes (id,scopeKey,workspaceId,userId,notebookId,title,content,contentText,contentFormat,colorMark,isPinned,isFavorite,isLocked,isArchived,isTrashed,trashedAt,version,sortOrder,createdAt,updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,"personal",null,this.userId,notebookId,payload.title,row["content"],row["contentText"],row["contentFormat"],row["colorMark"]??null,row["isPinned"],row["isFavorite"],row["isLocked"],row["isArchived"],row["isTrashed"],row["trashedAt"],1,row["sortOrder"],createdAt,createdAt]);
        await this.enqueue(tx,"note",id,"upsert",payload,undefined,"personal");
      }
      for(const row of noteTags){const noteId=noteMap.get(row.noteId),tagId=tagMap.get(row.tagId);if(!noteId||!tagId)continue;
        await tx.run("INSERT OR IGNORE INTO note_tags (scopeKey,workspaceId,noteId,tagId,createdAt) VALUES ('personal',NULL,?,?,?)",[noteId,tagId,now()]);
        await this.enqueue(tx,"note_tag",`${noteId}:${tagId}`,"upsert",{noteId,tagId,workspaceId:null},undefined,"personal");}
      for(const row of attachments){const copied=attachmentMap.get(String(row.id)),noteId=noteMap.get(String(row.noteId));if(!copied||!noteId)continue;const createdAt=now();
        const payload={id:copied.id,noteId,userId:this.userId,workspaceId:null,filename:row.filename,mimeType:row.mimeType,size:copied.size,hash:copied.hash,createdAt};
        await tx.run(`INSERT INTO attachments (id,scopeKey,workspaceId,noteId,userId,filename,mimeType,size,localPath,hash,available,transferStatus,createdAt,updatedAt)
          VALUES (?,'personal',NULL,?,?,?,?,?,?,?,1,'pending_upload',?,?)`,[copied.id,noteId,this.userId,row.filename,row.mimeType,copied.size,copied.path,copied.hash,createdAt,createdAt]);
        await this.enqueue(tx,"attachment",copied.id,"upsert",payload,undefined,"personal");}
    });
    return {notebooks:notebookMap.size,notes:noteMap.size,attachments:attachmentMap.size,tasks:0};
  }

  private async listNotes(query: NoteQuery = {}, requestedScopeKey?: string): Promise<NoteListItem[]> {
    const scopeKey = requestedScopeKey || this.scope().scopeKey;
    const where = ["n.scopeKey = ?"];
    const values: unknown[] = [scopeKey];
    if (query.notebookId) { where.push("n.notebookId = ?"); values.push(query.notebookId); }
    if (query.tagId) {
      where.push("EXISTS (SELECT 1 FROM note_tags nt WHERE nt.scopeKey=n.scopeKey AND nt.noteId=n.id AND nt.tagId=?)");
      values.push(query.tagId);
    }
    if (query.keyword) {
      where.push("(n.title LIKE ? OR n.contentText LIKE ?)");
      values.push(`%${query.keyword}%`, `%${query.keyword}%`);
    }
    if (query.trashedOnly) where.push("n.isTrashed = 1");
    else if (!query.includeTrashed) where.push("n.isTrashed = 0");
    if (query.favoriteOnly) where.push("n.isFavorite = 1");
    if (!query.includeArchived) where.push("n.isArchived = 0");
    values.push(Math.max(1, query.limit ?? 500), Math.max(0, query.offset ?? 0));
    return await this.db.query<NoteListItem>(`
      SELECT ${NOTE_LIST_COLUMNS} FROM notes n WHERE ${where.join(" AND ")}
      ORDER BY n.isPinned DESC, n.updatedAt DESC LIMIT ? OFFSET ?
    `, values);
  }

  private async getNote(id: string, db: NativeDatabase = this.db, requiredScopeKey?: string): Promise<Note | null> {
    const currentScopeKey = this.scope().scopeKey;
    const rows = await db.query<Note>(`SELECT * FROM notes WHERE id=? ${requiredScopeKey ? "AND scopeKey=?" : ""}
      ORDER BY CASE WHEN scopeKey=? THEN 0 ELSE 1 END LIMIT 1`, [id,...(requiredScopeKey ? [requiredScopeKey] : []),currentScopeKey]);
    if (!rows[0]) return null;
    const scopeKey = this.scopeFromWorkspace(rows[0].workspaceId).scopeKey;
    const tags = await db.query<Tag>(`
      SELECT t.* FROM tags t JOIN note_tags nt
        ON nt.scopeKey=t.scopeKey AND nt.tagId=t.id
      WHERE nt.scopeKey=? AND nt.noteId=? ORDER BY t.name
    `, [scopeKey, id]);
    return { ...rows[0], tags };
  }

  private async insertNote(tx: NativeDatabase, input: Partial<Note> & { id: string }, localCreation: boolean): Promise<WriteResult> {
    validateEncryptedNoteWrite(input as Record<string, unknown>);
    const scope = input.workspaceId !== undefined
      ? this.scopeFromWorkspace(input.workspaceId)
      : this.scope();
    if (localCreation) await this.assertWritable(scope.scopeKey, tx);
    const savedAt = now();
    const row = {
      id: input.id, scopeKey: scope.scopeKey, workspaceId: scope.workspaceId,
      userId: this.userId, notebookId: input.notebookId || "", title: input.title || "无标题笔记",
      content: input.content ?? "{}", contentText: input.contentText ?? "",
      contentFormat: input.contentFormat || "tiptap-json", colorMark: input.colorMark ?? null, isPinned: bool(input.isPinned),
      isFavorite: bool(input.isFavorite), isLocked: bool(input.isLocked),
      isArchived: bool(input.isArchived), isTrashed: bool(input.isTrashed),
      trashedAt: input.trashedAt ?? null, version: Math.max(1, input.version || 1),
      sortOrder: input.sortOrder || 0, createdAt: input.createdAt || savedAt, updatedAt: savedAt,
    };
    await tx.run(`INSERT INTO notes (
        id,scopeKey,workspaceId,userId,notebookId,title,content,contentText,contentFormat,colorMark,
        isPinned,isFavorite,isLocked,isArchived,isTrashed,trashedAt,version,sortOrder,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, Object.values(row));
    if (localCreation) {
      await tx.run(`INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,'1',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`, [unsentLocalNoteKey(scope.scopeKey, input.id), savedAt]);
      await this.enqueue(tx, "note", input.id, "upsert", row, undefined, scope.scopeKey);
    }
    return { id: input.id, savedAt };
  }

  private async createNote(input: Partial<Note> & { id: string }): Promise<WriteResult> {
    const result = await this.db.transaction((tx) => this.insertNote(tx, input, true));
    // The receipt is invalidated only after the SQLite Outbox transaction commits.
    notifyMobileSyncStatusChanged();
    return result;
  }

  private async ensurePersonalRootNotebook(tx: NativeDatabase, enqueue: boolean): Promise<string> {
    const id = `${ROOT_DOCUMENT_NOTEBOOK_PREFIX}personal:${this.userId}`;
    const timestamp = now();
    const row = { id, scopeKey: "personal", workspaceId: null, userId: this.userId, parentId: null,
      name: "__NOWEN_ROOT_DOCUMENTS__", icon: "📄", sortOrder: -2147483648, isExpanded: 0,
      isDeleted: 1, deletedAt: timestamp, createdAt: timestamp, updatedAt: timestamp };
    const inserted = await tx.run(`INSERT OR IGNORE INTO notebooks
      (id,scopeKey,workspaceId,userId,parentId,name,icon,sortOrder,isExpanded,isDeleted,deletedAt,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, Object.values(row));
    if (inserted.changes && enqueue) await this.enqueue(tx, "notebook", id, "upsert", row, undefined, "personal");
    return id;
  }

  /** Personal root/folder documents use the existing notebook/note Sync V2 entities. */
  async createPersonalTreeNote(input: Partial<Note> & { id: string }, notebookId: string | null): Promise<WriteResult> {
    const result = await this.db.transaction(async (tx) => {
      if (input.workspaceId) throw new Error("本机知识树创建仅支持个人空间");
      if (notebookId) {
        const parent = (await tx.query<{ userId: string; isDeleted: number }>(
          "SELECT userId,isDeleted FROM notebooks WHERE scopeKey='personal' AND id=?", [notebookId],
        ))[0];
        if (!parent || parent.userId !== this.userId || parent.isDeleted) throw new Error("本机父文件夹不存在或不可写");
      }
      const parent = notebookId || await this.ensurePersonalRootNotebook(tx, true);
      const saved = await this.insertNote(tx, { ...input, workspaceId: null, notebookId: parent }, true);
      // This records only locally created content, never inferred from a cached remote note.
      await tx.run("INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,?,?)",
        [`localTreeDraft:personal:${input.id}`, JSON.stringify(notebookId ? `notebook:${notebookId}` : null), saved.savedAt]);
      return saved;
    });
    notifyMobileSyncStatusChanged();
    return result;
  }

  async listLocalTreeDrafts(): Promise<Array<NoteListItem & { treeParentId: string | null }>> {
    const rows = await this.db.query<NoteListItem & { treeParent: string }>(`SELECT ${NOTE_LIST_METADATA_COLUMNS},'' AS contentText,m.value AS treeParent
      FROM notes n JOIN native_runtime_meta m ON m.key='localTreeDraft:personal:' || n.id
      WHERE n.scopeKey='personal' AND n.userId=? AND n.isTrashed=0`, [this.userId]);
    return rows.map(({ treeParent, ...note }) => ({ ...note, treeParentId: JSON.parse(treeParent) as string | null }));
  }

  /** Only call after live remote authorization; never enqueue another creation. */
  async hydrateAuthorizedNote(note: Note, notebook?: Notebook): Promise<Note> {
    if (note.workspaceId || note.userId !== this.userId || !Number.isSafeInteger(note.version) || note.version < 1) {
      throw new Error("远端笔记身份或空间校验失败");
    }
    return this.db.transaction(async (tx) => {
      const current = await this.getNote(note.id, tx, "personal");
      if (current) return current;
      const blocked = (await tx.query(`SELECT entityId FROM sync_outbox WHERE scopeKey='personal' AND entityType='note' AND entityId=?
        UNION ALL SELECT entityId FROM sync_conflicts WHERE scopeKey='personal' AND entityType='note' AND entityId=? AND status='unresolved' LIMIT 1`, [note.id, note.id])).length;
      if (blocked) throw new Error("笔记在本机已删除或存在待处理修改，不能从远端重新创建");
      const parent = (await tx.query("SELECT id FROM notebooks WHERE scopeKey='personal' AND id=?", [note.notebookId]))[0];
      if (!parent) {
        if (note.notebookId === `${ROOT_DOCUMENT_NOTEBOOK_PREFIX}personal:${this.userId}`) {
          await this.ensurePersonalRootNotebook(tx, false);
        } else {
          if (!notebook || notebook.id !== note.notebookId || notebook.userId !== this.userId || notebook.workspaceId) {
            throw new Error("远端笔记父文件夹身份校验失败");
          }
          await tx.run(`INSERT INTO notebooks (id,scopeKey,workspaceId,userId,name,description,icon,color,sortOrder,isExpanded,createdAt,updatedAt)
            VALUES (?,'personal',NULL,?,?,?,?,?,?,?,?,?)`, [notebook.id,this.userId,notebook.name,notebook.description ?? null,
            notebook.icon || "📒",notebook.color ?? null,notebook.sortOrder || 0,notebook.isExpanded ?? 1,notebook.createdAt || now(),notebook.updatedAt || now()]);
        }
      }
      await this.insertNote(tx, { ...note, workspaceId: null }, false);
      return (await this.getNote(note.id, tx, "personal"))!;
    });
  }

  private async updateNote(id: string, patch: Partial<Note>): Promise<WriteResult> {
    const result = await this.db.transaction(async (tx) => {
      const current = await this.getNote(id, tx);
      if (!current) throw new Error("笔记不存在");
      validateEncryptedNoteWrite(patch as Record<string, unknown>, current as unknown as Record<string, unknown>);
      if (isEncryptedNoteFormat(current.contentFormat) && patch.version !== undefined && patch.version !== current.version) throw Object.assign(new Error("笔记版本已改变"), { status: 409, code: "VERSION_CONFLICT" });
      const encrypted = isEncryptedNoteFormat(current.contentFormat);
      if (encrypted && patch.content !== undefined && !Number.isSafeInteger(patch.version)) throw Object.assign(new Error("加密正文保存需要明确版本"), { status: 409, code: "VERSION_CONFLICT" });
      const next = { ...current, ...patch, id, updatedAt: now(), version: current.version + 1 };
      const scope = this.scopeFromWorkspace(current.workspaceId);
      await this.assertWritable(scope.scopeKey, tx);
      const changed = await tx.run(`UPDATE notes SET notebookId=?,title=?,content=?,contentText=?,contentFormat=?,colorMark=?,
        isPinned=?,isFavorite=?,isLocked=?,isArchived=?,isTrashed=?,trashedAt=?,version=?,sortOrder=?,updatedAt=?
        WHERE scopeKey=? AND id=?${encrypted ? " AND version=?" : ""}`, [
        next.notebookId, next.title, next.content, next.contentText, next.contentFormat || "tiptap-json", next.colorMark ?? null,
        bool(next.isPinned), bool(next.isFavorite), bool(next.isLocked), bool(next.isArchived),
        bool(next.isTrashed), next.trashedAt, next.version, next.sortOrder || 0, next.updatedAt,
        scope.scopeKey, id, ...(encrypted ? [current.version] : []),
      ]);
      if (encrypted && changed.changes !== 1) throw Object.assign(new Error("笔记版本已改变"), { status: 409, code: "VERSION_CONFLICT" });
      await this.enqueue(tx, "note", id, "upsert", next as unknown as Record<string, unknown>, current.version, scope.scopeKey);
      return { id, savedAt: next.updatedAt };
    });
    // Refresh per-note receipt from committed Outbox, even while a push is in flight.
    notifyMobileSyncStatusChanged();
    return result;
  }

  private async deleteTrashedNote(tx:NativeDatabase,note:Note,scopeKey:string):Promise<void> {
    if(note.isLocked===1) throw Object.assign(new Error("Note is locked"),{code:"NOTE_LOCKED",status:403});
    if(note.isTrashed!==1) throw Object.assign(new Error("请先将笔记移入回收站，再永久删除"),{code:"NOTE_NOT_TRASHED",status:409});
    const attachments=await tx.query<Record<string,unknown>>("SELECT * FROM attachments WHERE scopeKey=? AND noteId=?",[scopeKey,note.id]);
    const tree=await tx.query("SELECT * FROM native_knowledge_tree_nodes WHERE scopeKey=? AND resourceType='note' AND resourceId=?",[scopeKey,note.id]);
    await this.enqueue(tx,"note",note.id,"delete",{...note,_deletionRecovery:{note,attachments,tree}},note.version,scopeKey);
    await tx.run("UPDATE native_knowledge_tree_nodes SET parentId=NULL WHERE scopeKey=? AND parentId IN (SELECT id FROM native_knowledge_tree_nodes WHERE scopeKey=? AND resourceType='note' AND resourceId=?)",[scopeKey,scopeKey,note.id]);
    await tx.run("DELETE FROM native_knowledge_tree_nodes WHERE scopeKey=? AND resourceType='note' AND resourceId=?",[scopeKey,note.id]);
    await tx.run("DELETE FROM notes WHERE scopeKey=? AND id=?",[scopeKey,note.id]);
    await tx.run("DELETE FROM native_runtime_meta WHERE key=?",[unsentLocalNoteKey(scopeKey,note.id)]);
  }

  private async removeNote(id: string): Promise<void> {
    const current = await this.getNote(id);
    if (!current) return;
    const scope = this.scopeFromWorkspace(current.workspaceId);
    await this.assertWritable(scope.scopeKey);
    await this.db.transaction(async (tx) => {
      const latest = await this.getNote(id, tx, scope.scopeKey);
      if (!latest) return;
      await this.deleteTrashedNote(tx,latest,scope.scopeKey);
    });
    notifyMobileSyncStatusChanged();
  }

  private async listNotebooks(requestedScopeKey?: string): Promise<Notebook[]> {
    const scopeKey = requestedScopeKey || this.scope().scopeKey;
    return await this.db.query<Notebook>(`
      SELECT n.*, (SELECT COUNT(*) FROM notes x WHERE x.scopeKey=n.scopeKey AND x.notebookId=n.id AND x.isTrashed=0) AS noteCount
      FROM notebooks n WHERE n.scopeKey=? AND n.isDeleted=0 ORDER BY n.sortOrder,n.createdAt
    `, [scopeKey]);
  }

  private async getNotebook(id: string): Promise<Notebook | null> {
    const { scopeKey } = this.scope();
    return (await this.db.query<Notebook>("SELECT * FROM notebooks WHERE scopeKey=? AND id=?", [scopeKey, id]))[0] || null;
  }

  private async createNotebook(input: Partial<Notebook> & { id: string }): Promise<WriteResult> {
    const scope = input.workspaceId !== undefined
      ? this.scopeFromWorkspace(input.workspaceId)
      : this.scope();
    await this.assertWritable(scope.scopeKey);
    const savedAt = now();
    const row = {
      id: input.id, scopeKey: scope.scopeKey, workspaceId: scope.workspaceId, userId: this.userId,
      parentId: input.parentId ?? null, name: input.name || "未命名笔记本",
      description: input.description ?? null, icon: input.icon || "📒", color: input.color ?? null,
      sortOrder: input.sortOrder || 0, isExpanded: input.isExpanded ?? 1, isDeleted: 0,
      deletedAt: null, createdAt: input.createdAt || savedAt, updatedAt: savedAt,
    };
    await this.db.transaction(async (tx) => {
      await tx.run(`INSERT INTO notebooks (
        id,scopeKey,workspaceId,userId,parentId,name,description,icon,color,sortOrder,
        isExpanded,isDeleted,deletedAt,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, Object.values(row));
      await this.enqueue(tx, "notebook", input.id, "upsert", row);
    });
    return { id: input.id, savedAt };
  }

  private async updateNotebook(id: string, patch: Partial<Notebook>): Promise<WriteResult> {
    const current = await this.getNotebook(id);
    if (!current) throw new Error("笔记本不存在");
    const next = { ...current, ...patch, id, updatedAt: now() };
    const { scopeKey } = this.scope();
    await this.assertWritable(scopeKey);
    await this.db.transaction(async (tx) => {
      await tx.run(`UPDATE notebooks SET parentId=?,name=?,description=?,icon=?,color=?,sortOrder=?,isExpanded=?,updatedAt=?
        WHERE scopeKey=? AND id=?`, [next.parentId,next.name,next.description,next.icon,next.color,
        next.sortOrder,bool(next.isExpanded),next.updatedAt,scopeKey,id]);
      await this.enqueue(tx, "notebook", id, "upsert", next as unknown as Record<string, unknown>);
    });
    return { id, savedAt: next.updatedAt };
  }

  private async removeNotebook(id: string): Promise<void> {
    const { scopeKey } = this.scope();
    await this.assertWritable(scopeKey);
    await this.db.transaction(async (tx) => {
      await tx.run("UPDATE notebooks SET isDeleted=1,deletedAt=?,updatedAt=? WHERE scopeKey=? AND id=?", [now(),now(),scopeKey,id]);
      await this.enqueue(tx, "notebook", id, "delete");
    });
  }

  private async listTags(requestedScopeKey?:string): Promise<Tag[]> {
    const scopeKey=requestedScopeKey||this.scope().scopeKey;
    return await this.db.query<Tag>(`SELECT t.*,
      (SELECT COUNT(*) FROM note_tags nt WHERE nt.scopeKey=t.scopeKey AND nt.tagId=t.id) AS noteCount
      FROM tags t WHERE t.scopeKey=? ORDER BY t.name`, [scopeKey]);
  }

  private async createTag(input: Partial<Tag> & { id: string }): Promise<WriteResult> {
    const scope = input.workspaceId !== undefined
      ? this.scopeFromWorkspace(input.workspaceId)
      : this.scope();
    await this.assertWritable(scope.scopeKey);
    const savedAt = now();
    const row = { id: input.id, scopeKey: scope.scopeKey, workspaceId: scope.workspaceId,
      userId: this.userId, name: input.name || "未命名标签", color: input.color || "#58a6ff",
      createdAt: input.createdAt || savedAt, updatedAt: savedAt };
    await this.db.transaction(async (tx) => {
      await tx.run("INSERT INTO tags (id,scopeKey,workspaceId,userId,name,color,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)", Object.values(row));
      await this.enqueue(tx, "tag", input.id, "upsert", row);
    });
    return { id: input.id, savedAt };
  }

  private async updateTag(id: string, patch: Partial<Tag>): Promise<WriteResult> {
    const { scopeKey } = this.scope();
    await this.assertWritable(scopeKey);
    const current = (await this.db.query<Tag & { updatedAt?: string }>("SELECT * FROM tags WHERE scopeKey=? AND id=?", [scopeKey,id]))[0];
    if (!current) throw new Error("标签不存在");
    const next = { ...current, ...patch, id, updatedAt: now() };
    await this.db.transaction(async (tx) => {
      await tx.run("UPDATE tags SET name=?,color=?,updatedAt=? WHERE scopeKey=? AND id=?", [next.name,next.color,next.updatedAt,scopeKey,id]);
      await this.enqueue(tx, "tag", id, "upsert", next as unknown as Record<string, unknown>);
    });
    return { id, savedAt: next.updatedAt };
  }

  private async removeTag(id: string): Promise<void> {
    const { scopeKey } = this.scope();
    await this.assertWritable(scopeKey);
    await this.db.transaction(async (tx) => {
      await tx.run("DELETE FROM tags WHERE scopeKey=? AND id=?", [scopeKey,id]);
      await this.enqueue(tx, "tag", id, "delete");
    });
  }

  private async attachTag(noteId: string, tagId: string): Promise<void> {
    const note=await this.getNote(noteId);
    if(!note)throw new Error("笔记不存在");
    const scope=this.scopeFromWorkspace(note.workspaceId);
    await this.assertWritable(scope.scopeKey);
    await this.db.transaction(async (tx) => {
      await tx.run("INSERT OR IGNORE INTO note_tags (scopeKey,workspaceId,noteId,tagId,createdAt) VALUES (?,?,?,?,?)",
        [scope.scopeKey,scope.workspaceId,noteId,tagId,now()]);
      await this.enqueue(tx, "note_tag", `${noteId}:${tagId}`, "upsert", { noteId,tagId,workspaceId:scope.workspaceId });
    });
  }

  private async detachTag(noteId: string, tagId: string): Promise<void> {
    const note=await this.getNote(noteId);
    if(!note)return;
    const {scopeKey}=this.scopeFromWorkspace(note.workspaceId);
    await this.assertWritable(scopeKey);
    await this.db.transaction(async (tx) => {
      await tx.run("DELETE FROM note_tags WHERE scopeKey=? AND noteId=? AND tagId=?", [scopeKey,noteId,tagId]);
      await this.enqueue(tx, "note_tag", `${noteId}:${tagId}`, "delete");
    });
  }

  private async listAttachments(noteId: string): Promise<LocalAttachmentRecord[]> {
    const { scopeKey } = this.scope();
    const rows = await this.db.query<Omit<LocalAttachmentRecord, "available"> & { available: number }>(`
      SELECT id,noteId,filename,mimeType,size,available FROM attachments
      WHERE scopeKey=? AND noteId=? ORDER BY createdAt
    `, [scopeKey,noteId]);
    return rows.map((row) => ({ ...row, available: Boolean(row.available) }));
  }

  private async saveAttachment(input: {
    id: string; noteId: string; filename: string; mimeType: string; blob: Blob;
  }): Promise<LocalAttachmentRecord> {
    const note = await this.getNote(input.noteId);
    if (!note) throw new Error("附件所属笔记不存在");
    const scope = this.scopeFromWorkspace(note.workspaceId);
    await this.assertWritable(scope.scopeKey);
    const stored = await this.attachmentStore.save({ attachmentId: input.id, data: input.blob });
    const savedAt = now();
    const payload = { id:input.id,noteId:input.noteId,userId:this.userId,workspaceId:scope.workspaceId,
      filename:input.filename,mimeType:input.mimeType,size:stored.size,hash:stored.sha256,createdAt:savedAt };
    try {
      await this.db.transaction(async (tx) => {
        await tx.run(`INSERT INTO attachments (
          id,scopeKey,workspaceId,noteId,userId,filename,mimeType,size,localPath,hash,
          available,transferStatus,createdAt,updatedAt
        ) VALUES (?,?,?,?,?,?,?,?,?,?,1,'pending_upload',?,?)`, [
          input.id,scope.scopeKey,scope.workspaceId,input.noteId,this.userId,input.filename,
          input.mimeType,stored.size,stored.path,stored.sha256,savedAt,savedAt,
        ]);
        await this.enqueue(tx, "attachment", input.id, "upsert", payload);
      });
    } catch (error) {
      await this.attachmentStore.remove(input.id).catch(() => undefined);
      throw error;
    }
    const localUrl = await this.attachmentStore.resolveUrl(input.id);
    if (localUrl) this.attachmentUrls.set(input.id, localUrl);
    return { id:input.id,noteId:input.noteId,filename:input.filename,mimeType:input.mimeType,size:stored.size,available:true };
  }

  private async removeAttachment(id: string): Promise<void> {
    const { scopeKey } = this.scope();
    await this.assertWritable(scopeKey);
    let syncEnabled = false;
    await this.db.transaction(async (tx) => {
      syncEnabled = Boolean(await this.syncContext(tx));
      await tx.run("DELETE FROM attachments WHERE scopeKey=? AND id=?", [scopeKey,id]);
      await this.enqueue(tx, "attachment", id, "delete");
    });
    if (!syncEnabled) await this.attachmentStore.remove(id);
    this.attachmentUrls.delete(id);
  }

  private async getSyncState(): Promise<SyncStateView> {
    const active = (await this.db.query<{ id: string }>("SELECT id FROM sync_profiles WHERE enabled=1 LIMIT 1"))[0];
    if (!active) return { mode: "device-only" };
    const pending = (await this.db.query<{ count: number }>("SELECT COUNT(*) AS count FROM sync_outbox WHERE profileId=? AND status IN ('pending','failed')", [active.id]))[0]?.count || 0;
    const conflicts = (await this.db.query<{ count: number }>("SELECT COUNT(*) AS count FROM sync_conflicts WHERE profileId=? AND status='unresolved'", [active.id]))[0]?.count || 0;
    const error = (await this.db.query<{ lastError: string | null }>("SELECT lastError FROM sync_state WHERE profileId=? AND lastError IS NOT NULL ORDER BY lastSyncAt DESC LIMIT 1", [active.id]))[0]?.lastError || null;
    return { mode: "server", pendingMutations: pending, conflictCount: conflicts, lastError: error };
  }
}

export function createNativeLocalRepository(options: NativeRepositoryOptions): NativeLocalRepository {
  return new NativeLocalRepository(options);
}
