import type {
  Diary,
  DiaryStats,
  DiaryTimeline,
  FileDetail,
  FileItem,
  FileListResponse,
  FileStats,
  MindMap,
  MindMapFolder,
  MindMapListItem,
  Task,
  TaskFilter,
  TaskStats,
} from "@/types";
import { api } from "./api";
import { newLocalId } from "./localRepository";
import type { NativeDatabase } from "./nativeDatabase";
import type { NativeLocalRepository } from "./nativeLocalRepository";

type SyncEntityType = "task" | "task_reminder" | "diary" | "mindmap" | "attachment";

function now(): string {
  return new Date().toISOString();
}

function dateKey(value: string): string {
  return value.slice(0, 10);
}

function parseArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

export function installMobileLocalModuleBridge(
  repository: NativeLocalRepository,
  db: NativeDatabase,
  userId: string,
): () => void {
  const target = api as any;
  const originals = {
    getTasks: target.getTasks,
    getTask: target.getTask,
    createTask: target.createTask,
    updateTask: target.updateTask,
    reorderTasks: target.reorderTasks,
    toggleTask: target.toggleTask,
    deleteTask: target.deleteTask,
    batchTasks: target.batchTasks,
    getTaskStats: target.getTaskStats,
    getTaskProjects: target.getTaskProjects,
    getTaskTemplates: target.getTaskTemplates,
    getTaskDependencies: target.getTaskDependencies,
    getReminderOverview: target.getReminderOverview,
    getTaskReminders: target.getTaskReminders,
    createTaskReminder: target.createTaskReminder,
    updateTaskReminder: target.updateTaskReminder,
    deleteTaskReminder: target.deleteTaskReminder,
    getHabits: target.getHabits,
    getHabitStats: target.getHabitStats,
    getHabitCheckinLog: target.getHabitCheckinLog,
    getMindMaps: target.getMindMaps,
    getMindMap: target.getMindMap,
    createMindMap: target.createMindMap,
    updateMindMap: target.updateMindMap,
    deleteMindMap: target.deleteMindMap,
    toggleStarMindMap: target.toggleStarMindMap,
    getMindMapFolders: target.getMindMapFolders,
    createMindMapFolder: target.createMindMapFolder,
    updateMindMapFolder: target.updateMindMapFolder,
    deleteMindMapFolder: target.deleteMindMapFolder,
    moveMindMap: target.moveMindMap,
    postDiary: target.postDiary,
    getDiaryTimeline: target.getDiaryTimeline,
    getDiaryStats: target.getDiaryStats,
    updateDiary: target.updateDiary,
    deleteDiary: target.deleteDiary,
    files: { ...target.files },
    attachmentFolders: { ...target.attachmentFolders },
    dataFileCleanupOrphans: target.dataFile.cleanupOrphans,
  };

  const enqueue = async (
    entityType: SyncEntityType,
    entityId: string,
    operation: "upsert" | "delete",
    payload?: Record<string, unknown>,
    baseVersion?: string | null,
  ) => {
    const sync = (await db.query<{ profileId: string; deviceId: string }>(`
      SELECT p.id AS profileId,d.deviceId FROM sync_profiles p
      JOIN sync_devices d ON d.profileId=p.id
      WHERE p.enabled=1 AND p.authStatus='ready' ORDER BY d.createdAt LIMIT 1
    `))[0];
    if (!sync) return;
    const body = payload ? { ...payload, ...(baseVersion ? { baseUpdatedAt: baseVersion } : {}) } : undefined;
    await db.run(`INSERT INTO sync_outbox (
      id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,payload,status,retryCount,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,'pending',0,?)`, [
      newLocalId(),newLocalId(),sync.profileId,sync.deviceId,"personal",entityType,entityId,operation,
      body ? JSON.stringify(body) : null,now(),
    ]);
    await repository.sync.requestSync();
  };

  const readTask = async (id: string): Promise<Task | null> => (
    await db.query<Task>("SELECT * FROM tasks WHERE scopeKey='personal' AND id=?", [id])
  )[0] || null;

  target.getTasks = async (filter: TaskFilter = "all", noteId?: string, projectId?: string): Promise<Task[]> => {
    const rows = await db.query<Task>("SELECT * FROM tasks WHERE scopeKey='personal' ORDER BY sortOrder,createdAt DESC");
    const today = dateKey(now());
    const weekEnd = new Date();
    weekEnd.setDate(weekEnd.getDate() + 7);
    return rows.filter((task) => {
      if (noteId && task.noteId !== noteId) return false;
      if (projectId && task.projectId !== projectId) return false;
      if (filter === "completed") return task.isCompleted === 1;
      if (filter === "today") return !task.isCompleted && dateKey(task.dueAt || task.dueDate || "") === today;
      if (filter === "overdue") return !task.isCompleted && !!(task.dueAt || task.dueDate) && dateKey(task.dueAt || task.dueDate || "") < today;
      if (filter === "week") {
        const due = task.dueAt || task.dueDate;
        return !task.isCompleted && !!due && new Date(due) <= weekEnd;
      }
      return true;
    });
  };
  target.getTask = async (id: string) => {
    const task = await readTask(id);
    if (!task) throw new Error("任务不存在");
    return task;
  };
  target.createTask = async (data: Partial<Task>): Promise<Task> => {
    const createdAt = now();
    const task: Task = {
      id:newLocalId(),userId,workspaceId:null,title:data.title?.trim() || "新任务",
      description:data.description || "",isCompleted:data.isCompleted ? 1 : 0,completedAt:data.completedAt || null,
      priority:data.priority || 2,dueDate:data.dueDate || null,dueAt:data.dueAt || null,startDate:data.startDate || null,
      noteId:data.noteId || null,parentId:data.parentId || null,sortOrder:data.sortOrder || 0,projectId:data.projectId || null,
      status:data.status || (data.isCompleted ? "done" : "todo"),createdAt,updatedAt:createdAt,
    };
    await db.run(`INSERT INTO tasks (
      id,scopeKey,workspaceId,userId,title,description,isCompleted,completedAt,priority,dueDate,dueAt,startDate,
      noteId,parentId,sortOrder,projectId,status,createdAt,updatedAt
    ) VALUES (?,'personal',NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      task.id,userId,task.title,task.description,task.isCompleted,task.completedAt,task.priority,task.dueDate,task.dueAt,
      task.startDate,task.noteId,task.parentId,task.sortOrder,task.projectId,task.status,task.createdAt,task.updatedAt,
    ]);
    await enqueue("task",task.id,"upsert",task as unknown as Record<string, unknown>);
    return task;
  };
  target.updateTask = async (id: string, patch: Partial<Task>) => {
    const current = await target.getTask(id) as Task;
    const updatedAt = now();
    const task = { ...current,...patch,id,userId,workspaceId:null,updatedAt };
    if (patch.isCompleted !== undefined && patch.status === undefined) task.status = patch.isCompleted ? "done" : "todo";
    await db.run(`UPDATE tasks SET title=?,description=?,isCompleted=?,completedAt=?,priority=?,dueDate=?,dueAt=?,startDate=?,
      noteId=?,parentId=?,sortOrder=?,projectId=?,status=?,updatedAt=? WHERE scopeKey='personal' AND id=?`, [
      task.title,task.description,task.isCompleted,task.completedAt,task.priority,task.dueDate,task.dueAt,task.startDate,
      task.noteId,task.parentId,task.sortOrder,task.projectId,task.status,updatedAt,id,
    ]);
    await enqueue("task",id,"upsert",task as unknown as Record<string, unknown>,current.updatedAt);
    return { task };
  };
  target.toggleTask = async (id: string) => {
    const current = await target.getTask(id) as Task;
    return target.updateTask(id,{
      isCompleted:current.isCompleted ? 0 : 1,
      status:current.isCompleted ? "todo" : "done",
      completedAt:current.isCompleted ? null : now(),
    });
  };
  target.deleteTask = async (id: string) => {
    await db.run("DELETE FROM tasks WHERE scopeKey='personal' AND (id=? OR parentId=?)",[id,id]);
    await enqueue("task",id,"delete");
    return { success:true };
  };
  target.reorderTasks = async (items: Array<{ id: string; sortOrder: number }>) => {
    for (const item of items) await target.updateTask(item.id,{ sortOrder:item.sortOrder });
    return { success:true,affected:items.length };
  };
  target.batchTasks = async (ids: string[], action: "complete" | "delete") => {
    for (const id of ids) {
      if (action === "delete") await target.deleteTask(id);
      else await target.updateTask(id,{ isCompleted:1,status:"done",completedAt:now() });
    }
    return { success:true,affected:ids.length };
  };
  target.getTaskStats = async (): Promise<TaskStats> => {
    const tasks = await target.getTasks("all") as Task[];
    const today = dateKey(now());
    return {
      total:tasks.length,completed:tasks.filter((item) => item.isCompleted).length,
      pending:tasks.filter((item) => !item.isCompleted).length,
      today:tasks.filter((item) => !item.isCompleted && dateKey(item.dueAt || item.dueDate || "") === today).length,
      overdue:tasks.filter((item) => !item.isCompleted && !!(item.dueAt || item.dueDate) && dateKey(item.dueAt || item.dueDate || "") < today).length,
      week:(await target.getTasks("week") as Task[]).length,
    };
  };
  target.getTaskProjects = async () => [];
  target.getTaskTemplates = async () => [];
  target.getTaskDependencies = async () => [];
  target.getHabits = async () => [];
  target.getHabitStats = async () => ({ totalCheckins:0,checkinDays:0,currentStreak:0,successCount:0,partialCount:0,failureCount:0,habitCount:0 });
  target.getHabitCheckinLog = async () => [];
  target.getReminderOverview = async () => ({ missed:[],today:[],upcoming:[],disabled:[] });
  target.getTaskReminders = async (taskId: string) => db.query("SELECT * FROM task_reminders WHERE taskId=? ORDER BY offsetMinutes",[taskId]);
  target.createTaskReminder = async (taskId: string, offsetMinutes: number) => {
    const id = newLocalId();const createdAt = now();
    const reminder = { id,taskId,userId,offsetMinutes,enabled:1,lastNotifiedAt:null,snoozedUntil:null,createdAt,updatedAt:createdAt };
    await db.run(`INSERT INTO task_reminders (id,taskId,userId,offsetMinutes,enabled,lastNotifiedAt,snoozedUntil,createdAt,updatedAt)
      VALUES (?,?,?,?,1,NULL,NULL,?,?)`,[id,taskId,userId,offsetMinutes,createdAt,createdAt]);
    await enqueue("task_reminder",id,"upsert",reminder);
    return reminder;
  };
  target.updateTaskReminder = async (id: string, patch: Record<string, unknown>) => {
    const current = (await db.query<Record<string, unknown>>("SELECT * FROM task_reminders WHERE id=?",[id]))[0];
    if (!current) throw new Error("提醒不存在");
    const reminder: Record<string, any> = { ...current,...patch,updatedAt:now() };
    await db.run("UPDATE task_reminders SET offsetMinutes=?,enabled=?,snoozedUntil=?,updatedAt=? WHERE id=?",[
      reminder.offsetMinutes,reminder.enabled,reminder.snoozedUntil,reminder.updatedAt,id,
    ]);
    await enqueue("task_reminder",id,"upsert",reminder);
    return reminder;
  };
  target.deleteTaskReminder = async (id: string) => {
    await db.run("DELETE FROM task_reminders WHERE id=?",[id]);await enqueue("task_reminder",id,"delete");return {success:true};
  };

  target.getDiaryTimeline = async (_cursor?: string, limit = 20, range?: Record<string, string>): Promise<DiaryTimeline> => {
    let rows = await db.query<Record<string, unknown>>("SELECT * FROM diaries WHERE scopeKey='personal' ORDER BY createdAt DESC");
    if (range?.from) rows = rows.filter((row) => String(row.createdAt) >= range.from!);
    if (range?.to) rows = rows.filter((row) => String(row.createdAt) <= `${range.to}T23:59:59.999Z`);
    if (range?.mood) rows = rows.filter((row) => row.mood === range.mood);
    if (range?.q) rows = rows.filter((row) => String(row.contentText).toLowerCase().includes(range.q!.toLowerCase()));
    const items = rows.slice(0,limit).map((row) => ({ ...row,images:parseArray<string>(row.images),media:parseArray(row.media) })) as unknown as Diary[];
    return { items,hasMore:rows.length > items.length,nextCursor:null };
  };
  target.getDiaryStats = async (): Promise<DiaryStats> => {
    const rows = await db.query<{ createdAt: string }>("SELECT createdAt FROM diaries WHERE scopeKey='personal'");
    const today = dateKey(now());return {total:rows.length,todayCount:rows.filter((row) => dateKey(row.createdAt) === today).length};
  };
  target.postDiary = async (data: Partial<Diary>): Promise<Diary> => {
    const diary: Diary = { id:newLocalId(),userId,workspaceId:null,contentText:data.contentText || "",mood:data.mood || "",images:data.images || [],media:data.media || [],createdAt:data.createdAt || now() };
    await db.run("INSERT INTO diaries (id,scopeKey,workspaceId,userId,contentText,mood,images,media,createdAt) VALUES (?,'personal',NULL,?,?,?,?,?,?)",[
      diary.id,userId,diary.contentText,diary.mood,JSON.stringify(diary.images),JSON.stringify(diary.media),diary.createdAt,
    ]);
    await enqueue("diary",diary.id,"upsert",diary as unknown as Record<string, unknown>);return diary;
  };
  target.updateDiary = async (id: string, patch: Partial<Diary>): Promise<Diary> => {
    const row = (await db.query<Record<string, unknown>>("SELECT * FROM diaries WHERE id=?",[id]))[0];
    if (!row) throw new Error("记录不存在");
    const diary = { ...row,...patch,id,userId,workspaceId:null,images:patch.images || parseArray(row.images),media:patch.media || parseArray(row.media) } as unknown as Diary;
    await db.run("UPDATE diaries SET contentText=?,mood=?,images=?,media=?,createdAt=? WHERE id=?",[
      diary.contentText,diary.mood,JSON.stringify(diary.images),JSON.stringify(diary.media),diary.createdAt,id,
    ]);
    await enqueue("diary",id,"upsert",diary as unknown as Record<string, unknown>);return diary;
  };
  target.deleteDiary = async (id: string) => { await db.run("DELETE FROM diaries WHERE id=?",[id]);await enqueue("diary",id,"delete");return {success:true}; };

  const readMindMap = async (id: string): Promise<MindMap> => {
    const map = (await db.query<MindMap>("SELECT * FROM mindmaps WHERE scopeKey='personal' AND id=?",[id]))[0];
    if (!map) throw new Error("思维导图不存在");return map;
  };
  target.getMindMaps = async (): Promise<MindMapListItem[]> => db.query("SELECT id,userId,workspaceId,title,starred,folderId,createdAt,updatedAt FROM mindmaps WHERE scopeKey='personal' ORDER BY starred DESC,updatedAt DESC");
  target.getMindMap = readMindMap;
  target.createMindMap = async (data: { title?: string; data?: string }): Promise<MindMap> => {
    const createdAt=now();const map:MindMap={id:newLocalId(),userId,workspaceId:null,title:data.title||"无标题导图",data:data.data||JSON.stringify({root:{id:"root",text:"中心主题",children:[]}}),createdAt,updatedAt:createdAt};
    await db.run("INSERT INTO mindmaps (id,scopeKey,workspaceId,userId,title,data,starred,folderId,createdAt,updatedAt) VALUES (?,'personal',NULL,?,?,?,0,NULL,?,?)",[map.id,userId,map.title,map.data,createdAt,createdAt]);
    await enqueue("mindmap",map.id,"upsert",map as unknown as Record<string, unknown>);return map;
  };
  target.updateMindMap = async (id:string,patch:Partial<MindMap>):Promise<MindMap> => {
    const current=await readMindMap(id);const map={...current,...patch,id,userId,workspaceId:null,updatedAt:now()};
    await db.run("UPDATE mindmaps SET title=?,data=?,updatedAt=? WHERE id=?",[map.title,map.data,map.updatedAt,id]);
    await enqueue("mindmap",id,"upsert",map as unknown as Record<string, unknown>,current.updatedAt);return map;
  };
  target.deleteMindMap = async (id:string)=>{await db.run("DELETE FROM mindmaps WHERE id=?",[id]);await enqueue("mindmap",id,"delete");return {success:true};};
  target.toggleStarMindMap = async (id:string)=>{const current=await readMindMap(id);await db.run("UPDATE mindmaps SET starred=CASE starred WHEN 1 THEN 0 ELSE 1 END WHERE id=?",[id]);return {...current,starred:(current as any).starred?0:1};};
  target.getMindMapFolders = async ():Promise<MindMapFolder[]> => db.query("SELECT *,0 AS mindmapCount FROM mindmap_folders WHERE scopeKey='personal' ORDER BY sortOrder,createdAt");
  target.createMindMapFolder = async (data:Partial<MindMapFolder>)=>{const createdAt=now();const folder={id:newLocalId(),userId,workspaceId:null,parentId:data.parentId||null,name:data.name||"新建文件夹",sortOrder:data.sortOrder||0,createdAt,updatedAt:createdAt};await db.run("INSERT INTO mindmap_folders (id,scopeKey,workspaceId,userId,parentId,name,sortOrder,createdAt,updatedAt) VALUES (?,'personal',NULL,?,?,?,?,?,?)",[folder.id,userId,folder.parentId,folder.name,folder.sortOrder,createdAt,createdAt]);return folder;};
  target.updateMindMapFolder = async (id:string,patch:Partial<MindMapFolder>)=>{const current=(await db.query<MindMapFolder>("SELECT * FROM mindmap_folders WHERE id=?",[id]))[0];const folder={...current,...patch,updatedAt:now()};await db.run("UPDATE mindmap_folders SET parentId=?,name=?,sortOrder=?,updatedAt=? WHERE id=?",[folder.parentId,folder.name,folder.sortOrder,folder.updatedAt,id]);return folder;};
  target.deleteMindMapFolder = async (id:string)=>{await db.run("UPDATE mindmaps SET folderId=NULL WHERE folderId=?",[id]);await db.run("DELETE FROM mindmap_folders WHERE id=?",[id]);return {success:true};};
  target.moveMindMap = async (id:string,folderId:string|null)=>{await db.run("UPDATE mindmaps SET folderId=?,updatedAt=? WHERE id=?",[folderId,now(),id]);return readMindMap(id);};

  const fileRows = async (): Promise<Array<Record<string, unknown>>> => db.query(`SELECT a.*,n.title AS noteTitle,n.notebookId,n.isTrashed,b.name AS notebookName,b.icon AS notebookIcon
    FROM attachments a LEFT JOIN notes n ON n.scopeKey=a.scopeKey AND n.id=a.noteId
    LEFT JOIN notebooks b ON b.scopeKey=n.scopeKey AND b.id=n.notebookId
    WHERE a.scopeKey='personal' AND a.available=1`);
  const toFileItem = async (row:Record<string,unknown>):Promise<FileItem> => ({
    id:String(row.id),filename:String(row.filename),mimeType:String(row.mimeType),size:Number(row.size)||0,createdAt:String(row.createdAt),
    category:String(row.mimeType).startsWith("image/")?"image":"file",url:await repository.attachments.resolveUrl(String(row.id)) || "about:blank",
    hash:typeof row.hash === "string"?row.hash:null,folderId:null,folderName:null,
    primaryNote:row.noteId?{id:String(row.noteId),title:String(row.noteTitle||""),notebookId:row.notebookId?String(row.notebookId):null,notebookName:row.notebookName?String(row.notebookName):null,notebookIcon:row.notebookIcon?String(row.notebookIcon):null,isTrashed:Number(row.isTrashed)||0}:null,
  });
  target.files.stats = async ():Promise<FileStats>=>{const rows=await fileRows();const images=rows.filter((row)=>String(row.mimeType).startsWith("image/"));const files=rows.filter((row)=>!String(row.mimeType).startsWith("image/"));const sum=(items:Array<Record<string,unknown>>)=>items.reduce((total,row)=>total+(Number(row.size)||0),0);const byMime=[...new Set(rows.map((row)=>String(row.mimeType)))].map((mime)=>{const items=rows.filter((row)=>row.mimeType===mime);return {mime,count:items.length,bytes:sum(items)};});return {total:rows.length,totalBytes:sum(rows),images:{count:images.length,bytes:sum(images)},files:{count:files.length,bytes:sum(files)},unreferenced:{count:0,bytes:0},myUploads:{total:rows.length,referenced:rows.length,unreferenced:0},storage:{mode:"local",driver:"local",source:"default"},byMime};};
  target.files.list = async (params:Record<string,unknown>={}):Promise<FileListResponse>=>{let rows=await fileRows();if(params.category)rows=rows.filter((row)=>(String(row.mimeType).startsWith("image/")?"image":"file")===params.category);if(params.q)rows=rows.filter((row)=>String(row.filename).toLowerCase().includes(String(params.q).toLowerCase()));const items=await Promise.all(rows.map(toFileItem));const page=Number(params.page)||1,pageSize=Number(params.pageSize)||50,start=(page-1)*pageSize;return {items:items.slice(start,start+pageSize),total:items.length,page,pageSize};};
  target.files.get = async (id:string):Promise<FileDetail>=>{const row=(await fileRows()).find((item)=>item.id===id);if(!row)throw new Error("文件不存在");const item=await toFileItem(row);return {...item,references:item.primaryNote?[{...item.primaryNote,updatedAt:String(row.updatedAt),isPrimary:true}]:[]};};
  target.files.upload = async (file:File):Promise<FileItem>=>{let notebooks=await repository.notebooks.list();let notebook=notebooks[0];if(!notebook){const id=newLocalId();await repository.notebooks.create({id,name:"本地文件",icon:"📁"});notebook=(await repository.notebooks.get(id))!;}let holder=(await repository.notes.list({includeArchived:true,includeTrashed:true})).find((note)=>note.title==="本地文件");if(!holder){const id=newLocalId();await repository.notes.create({id,notebookId:notebook.id,title:"本地文件",isArchived:1});holder=(await repository.notes.get(id))!;}const id=newLocalId();await repository.attachments.save({id,noteId:holder.id,filename:file.name,mimeType:file.type||"application/octet-stream",blob:file});return target.files.get(id);};
  target.files.remove = async (id:string)=>{await repository.attachments.remove(id);return {success:true};};
  target.files.batchRemove = async (ids:string[])=>{const failed:Array<{id:string;reason:string}>=[];let deleted=0;for(const id of ids){try{await repository.attachments.remove(id);deleted+=1;}catch(error){failed.push({id,reason:error instanceof Error?error.message:"删除失败"});}}return {success:failed.length===0,deleted,failed};};
  target.files.rename = async (id:string,filename:string)=>{await db.run("UPDATE attachments SET filename=?,updatedAt=? WHERE id=?",[filename,now(),id]);const row=(await db.query<Record<string,unknown>>("SELECT * FROM attachments WHERE id=?",[id]))[0];if(row)await enqueue("attachment",id,"upsert",row);return {success:true,filename};};
  target.attachmentFolders.list = async()=>({folders:[]});
  target.dataFile.cleanupOrphans = async()=>({totalRemovedItems:0,totalFreedBytes:0,removed:{databaseRows:0,contentReferences:0,diskFiles:0}});

  return () => {
    Object.assign(target, originals);
    target.files = originals.files;
    target.attachmentFolders = originals.attachmentFolders;
    delete target.dataFileCleanupOrphans;
    target.dataFile.cleanupOrphans = originals.dataFileCleanupOrphans;
  };
}
