import type { Note, NoteListItem, Notebook, Tag, Workspace, WorkspaceRole } from "@/types";
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

type EntityType = "notebook" | "note" | "tag" | "note_tag" | "favorite" | "attachment";

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
    return this.db.query<NoteListItem>(`SELECT n.* FROM notes n JOIN note_tags nt
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
    const rows=await this.db.query<NoteListItem>(`SELECT * FROM notes WHERE scopeKey=? AND isTrashed=0
      AND (title LIKE ? OR contentText LIKE ?) ORDER BY updatedAt DESC LIMIT ?`,[scopeKey,needle,needle,Math.max(1,limit)]);
    const normalized=query.trim().toLocaleLowerCase();
    return rows.map((row)=>{
      const titleMatch=row.title.toLocaleLowerCase().includes(normalized);
      const content=row.contentText||"";
      const index=content.toLocaleLowerCase().indexOf(normalized);
      const snippet=index<0?content.slice(0,160):content.slice(Math.max(0,index-60),index+normalized.length+100);
      return {id:row.id,title:row.title,notebookId:row.notebookId,updatedAt:row.updatedAt,
        isFavorite:row.isFavorite,isPinned:row.isPinned,snippet,userId:row.userId,
        workspaceId:row.workspaceId,matchedField:titleMatch?(index>=0?"title+content":"title"):"content"};
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
    await this.db.transaction(async(tx)=>{
      for(const note of notes){
        await tx.run("DELETE FROM notes WHERE scopeKey=? AND id=?",[scopeKey,note.id]);
        await this.enqueue(tx,"note",note.id,"delete",undefined,note.version,scopeKey);
      }
    });
    await Promise.all(attachments.map(({id})=>this.attachmentStore.remove(id).catch(()=>undefined)));
    for(const {id} of attachments)this.attachmentUrls.delete(id);
    return {success:true,count:notes.length,skipped:0,noteIds:notes.map(({id})=>id),removedFiles:attachments.length};
  }

  private scope(): { scopeKey: string; workspaceId: string | null } {
    return this.scopeFromWorkspace(this.getScopeKey());
  }

  private scopeFromWorkspace(raw?: string | null): { scopeKey: string; workspaceId: string | null } {
    const scopeKey = raw && raw !== "personal" ? `workspace:${raw.replace(/^workspace:/, "")}` : "personal";
    return { scopeKey, workspaceId: workspaceIdFromScope(scopeKey) };
  }

  private async assertWritable(scopeKey:string):Promise<void> {
    if(scopeKey === "personal") return;
    const scope=(await this.db.query<{canWrite:number;accessStatus:string}>(
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
      WHERE p.enabled = 1 AND p.authStatus = 'ready'
      ORDER BY d.createdAt LIMIT 1
    `);
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
    this.requestSyncCallback?.();
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
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[payload.id,payload.scopeKey,payload.workspaceId,payload.userId,payload.parentId,payload.name,payload.description,payload.icon,payload.color,payload.sortOrder,payload.isExpanded,0,null,createdAt,createdAt]);
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
        await tx.run(`INSERT INTO notes (id,scopeKey,workspaceId,userId,notebookId,title,content,contentText,contentFormat,isPinned,isFavorite,isLocked,isArchived,isTrashed,trashedAt,version,sortOrder,createdAt,updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,"personal",null,this.userId,notebookId,payload.title,payload.content,payload.contentText,payload.contentFormat,payload.isPinned,payload.isFavorite,payload.isLocked,payload.isArchived,payload.isTrashed,payload.trashedAt,1,payload.sortOrder,createdAt,createdAt]);
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
      SELECT n.* FROM notes n WHERE ${where.join(" AND ")}
      ORDER BY n.isPinned DESC, n.updatedAt DESC LIMIT ? OFFSET ?
    `, values);
  }

  private async getNote(id: string): Promise<Note | null> {
    const currentScopeKey = this.scope().scopeKey;
    const rows = await this.db.query<Note>(`SELECT * FROM notes WHERE id=?
      ORDER BY CASE WHEN scopeKey=? THEN 0 ELSE 1 END LIMIT 1`, [id,currentScopeKey]);
    if (!rows[0]) return null;
    const scopeKey = this.scopeFromWorkspace(rows[0].workspaceId).scopeKey;
    const tags = await this.db.query<Tag>(`
      SELECT t.* FROM tags t JOIN note_tags nt
        ON nt.scopeKey=t.scopeKey AND nt.tagId=t.id
      WHERE nt.scopeKey=? AND nt.noteId=? ORDER BY t.name
    `, [scopeKey, id]);
    return { ...rows[0], tags };
  }

  private async createNote(input: Partial<Note> & { id: string }): Promise<WriteResult> {
    const scope = input.workspaceId !== undefined
      ? this.scopeFromWorkspace(input.workspaceId)
      : this.scope();
    await this.assertWritable(scope.scopeKey);
    const savedAt = now();
    const row = {
      id: input.id, scopeKey: scope.scopeKey, workspaceId: scope.workspaceId,
      userId: this.userId, notebookId: input.notebookId || "", title: input.title || "无标题笔记",
      content: input.content ?? "{}", contentText: input.contentText ?? "",
      contentFormat: input.contentFormat || "tiptap-json", isPinned: bool(input.isPinned),
      isFavorite: bool(input.isFavorite), isLocked: bool(input.isLocked),
      isArchived: bool(input.isArchived), isTrashed: bool(input.isTrashed),
      trashedAt: input.trashedAt ?? null, version: Math.max(1, input.version || 1),
      sortOrder: input.sortOrder || 0, createdAt: input.createdAt || savedAt, updatedAt: savedAt,
    };
    await this.db.transaction(async (tx) => {
      await tx.run(`INSERT INTO notes (
        id,scopeKey,workspaceId,userId,notebookId,title,content,contentText,contentFormat,
        isPinned,isFavorite,isLocked,isArchived,isTrashed,trashedAt,version,sortOrder,createdAt,updatedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, Object.values(row));
      await this.enqueue(tx, "note", input.id, "upsert", row);
    });
    return { id: input.id, savedAt };
  }

  private async updateNote(id: string, patch: Partial<Note>): Promise<WriteResult> {
    const current = await this.getNote(id);
    if (!current) throw new Error("笔记不存在");
    const next = { ...current, ...patch, id, updatedAt: now(), version: current.version + 1 };
    const scope = this.scopeFromWorkspace(current.workspaceId);
    await this.assertWritable(scope.scopeKey);
    await this.db.transaction(async (tx) => {
      await tx.run(`UPDATE notes SET notebookId=?,title=?,content=?,contentText=?,contentFormat=?,
        isPinned=?,isFavorite=?,isLocked=?,isArchived=?,isTrashed=?,trashedAt=?,version=?,sortOrder=?,updatedAt=?
        WHERE scopeKey=? AND id=?`, [
        next.notebookId, next.title, next.content, next.contentText, next.contentFormat || "tiptap-json",
        bool(next.isPinned), bool(next.isFavorite), bool(next.isLocked), bool(next.isArchived),
        bool(next.isTrashed), next.trashedAt, next.version, next.sortOrder || 0, next.updatedAt,
        scope.scopeKey, id,
      ]);
      await this.enqueue(tx, "note", id, "upsert", next as unknown as Record<string, unknown>, current.version);
    });
    return { id, savedAt: next.updatedAt };
  }

  private async removeNote(id: string): Promise<void> {
    const current = await this.getNote(id);
    if (!current) return;
    const scope = this.scopeFromWorkspace(current.workspaceId);
    await this.assertWritable(scope.scopeKey);
    await this.db.transaction(async (tx) => {
      await tx.run("DELETE FROM notes WHERE scopeKey=? AND id=?", [scope.scopeKey, id]);
      await this.enqueue(tx, "note", id, "delete", undefined, current?.version ?? null);
    });
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
