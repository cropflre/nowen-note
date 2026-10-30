import { isTaskCompletedToday } from "@/components/tasks/taskLifecycle";
import { getTaskComposerContext, isTaskComposerContextCurrent, registerTaskComposerCache, TaskComposerApiError, updateRepeatingTaskOnline } from "./taskComposerApi";
import i18n from "@/i18n";
import { cacheConfirmedNativeTasks } from "./nativeTaskComposerCache";
import { NATIVE_TASK_REPEAT_FIELDS, nativeTaskRepeatValues } from "./nativeTaskFields";
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
import { getCurrentWorkspace } from "./api.impl";
import { assetFileKind } from "./fileExplorerModel";
import { newLocalId } from "./localRepository";
import { isMobileLocalMode } from "./mobileLocalMode";
import { ensureMobileLocalMindMapTree } from "./mobileLocalMindMapTree";
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
  const removeComposerCache = registerTaskComposerCache((tasks, projects) => cacheConfirmedNativeTasks(db, userId, tasks, projects));
  const target = api as unknown as Omit<typeof api, "updateTask" | "toggleTask" | "updateTaskReminder" | "dataFile"> & {
    updateTask: (id: string, patch: Partial<Task>) => Promise<{ task: Task }>;
    toggleTask: (id: string) => Promise<{ task: Task }>;
    updateTaskReminder: (id: string, patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
    dataFile: Omit<typeof api.dataFile, "cleanupOrphans"> & {
      cleanupOrphans: () => Promise<Partial<Awaited<ReturnType<typeof api.dataFile.cleanupOrphans>>>>;
    };
    dataFileCleanupOrphans?: unknown;
  };
  const originals = {
    getTasks: target.getTasks,
    archiveTask: target.archiveTask,
    saveTaskAsNote: target.saveTaskAsNote,
    getTask: target.getTask,
    createTask: target.createTask,
    updateTask: target.updateTask,
    reorderTasks: target.reorderTasks,
    toggleTask: target.toggleTask,
    deleteTask: target.deleteTask,
    stopTaskRecurrence: target.stopTaskRecurrence,
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
    deleteMindMapPermanently: target.deleteMindMapPermanently,
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
      WHERE p.remoteUserId=? ORDER BY p.enabled DESC,p.updatedAt DESC,d.createdAt LIMIT 1
    `,[userId]))[0];
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
    const parentTitles = new Map(rows.map((task) => [task.id,task.title]));
    return rows.map((task) => ({...task,parentTitle:(task.parentId ? parentTitles.get(task.parentId) : null) || null})).filter((task) => {
      if (noteId && task.noteId !== noteId) return false;
      if (projectId && task.projectId !== projectId) return false;
      if (filter === "archived") return !!task.archivedAt;
      if (filter === "completed-today") return isTaskCompletedToday(task);
      if (filter !== "history" && task.archivedAt) return false;
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
  target.archiveTask = (id, archived = true) => repository.archiveTaskTree(id,archived);
  target.saveTaskAsNote = async (id, data) => repository.saveTaskNoteSnapshot(id,data);
  target.getTask = async (id: string) => {
    const task = await readTask(id);
    if (!task) throw new Error("任务不存在");
    return task;
  };
  target.createTask = async (data: Partial<Task>): Promise<Task> => {
    if (data.parentId && (await readTask(data.parentId))?.archivedAt) throw new Error("请先恢复已归档任务");
    const createdAt = now();
    const done = data.status === "done" || !!data.isCompleted;
    const task: Task = {
      id:newLocalId(),userId,workspaceId:null,title:data.title?.trim() || "新任务",
      description:data.description || "",isCompleted:done ? 1 : 0,
      completedAt:done ? (Object.prototype.hasOwnProperty.call(data,"completedAt") ? data.completedAt || null : createdAt) : null,
      priority:data.priority || 2,dueDate:data.dueDate || null,dueAt:data.dueAt || null,startDate:data.startDate || null,
      noteId:data.noteId || null,parentId:data.parentId || null,sortOrder:data.sortOrder || 0,projectId:data.projectId || null,
      status:data.status || (done ? "done" : "todo"),createdAt,updatedAt:createdAt,
      ...Object.fromEntries(NATIVE_TASK_REPEAT_FIELDS.map((field, index) => [field, nativeTaskRepeatValues(data)[index]])),
    };
    await db.run(`INSERT INTO tasks (
      id,scopeKey,workspaceId,userId,title,description,isCompleted,completedAt,priority,dueDate,dueAt,startDate,
      noteId,parentId,sortOrder,projectId,status,createdAt,updatedAt,${NATIVE_TASK_REPEAT_FIELDS.join(",")}
    ) VALUES (?,'personal',NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${NATIVE_TASK_REPEAT_FIELDS.map(() => "?").join(",")})`, [
      task.id,userId,task.title,task.description,task.isCompleted,task.completedAt,task.priority,task.dueDate,task.dueAt,
      task.startDate,task.noteId,task.parentId,task.sortOrder,task.projectId,task.status,task.createdAt,task.updatedAt,...nativeTaskRepeatValues(task),
    ]);
    await enqueue("task",task.id,"upsert",task as unknown as Record<string, unknown>);
    return task;
  };
  target.updateTask = async (id: string, patch: Partial<Task>) => {
    const current = await target.getTask(id) as Task;
    const recurrence = (await db.query<{ action: string }>("SELECT action FROM task_recurrence_state WHERE groupId=? AND scopeKey=?",[current.repeatGroupId || id,`personal:${userId}`]))[0];
    if (recurrence && patch.repeatRule && patch.repeatRule !== "none") throw new Error(i18n.t("taskRemoval.stopped"));
    if (current.archivedAt) throw new Error("请先恢复已归档任务");
    if (patch.parentId && (await readTask(patch.parentId))?.archivedAt) throw new Error("不能移动到已归档任务");
    if (current.repeatRule && current.repeatRule !== "none" && patch.isCompleted !== undefined) {
      const context = getTaskComposerContext();
      if (isMobileLocalMode() || navigator.onLine === false) throw new Error(i18n.t("taskComposer.repeatNeedsOnline"));
      const pending = await db.query("SELECT id FROM sync_outbox WHERE entityType='task' AND entityId=? AND status IN ('pending','inflight','failed') LIMIT 1", [id]);
      if (pending.length) throw new Error(i18n.t("taskComposer.repeatNeedsSync"));
      const result = await updateRepeatingTaskOnline(id, patch);
      let visibleTask = result.task;
      await db.transaction(async tx => {
        const concurrent = await tx.query("SELECT id FROM sync_outbox WHERE entityType='task' AND entityId=? AND status IN ('pending','inflight','failed') LIMIT 1", [id]);
        if (!concurrent.length) await tx.run("UPDATE tasks SET isCompleted=?,status=?,completedAt=?,repeatNextGeneratedId=?,updatedAt=? WHERE scopeKey='personal' AND id=?", [result.task.isCompleted,result.task.status,result.task.completedAt || null,result.task.repeatNextGeneratedId || null,result.task.updatedAt,id]);
        else visibleTask = (await tx.query<Task>("SELECT * FROM tasks WHERE scopeKey='personal' AND id=?", [id]))[0] || result.task;
      });
      if (result.generatedTask) await cacheConfirmedNativeTasks(db, userId, [result.generatedTask]);
      if (!isTaskComposerContextCurrent(context)) throw new TaskComposerApiError("CONTEXT_CHANGED");
      return { ...result, task: visibleTask };
    }
    const updatedAt = now();
    const task = { ...current,...patch,id,userId,workspaceId:null,updatedAt };
    if (patch.isCompleted !== undefined && patch.status === undefined) task.status = patch.isCompleted ? "done" : "todo";
    if (patch.status !== undefined && patch.isCompleted === undefined) task.isCompleted = patch.status === "done" ? 1 : 0;
    if (patch.isCompleted !== undefined || patch.status !== undefined) task.completedAt = task.isCompleted ? (current.isCompleted ? current.completedAt || now() : now()) : null;
    await db.run(`UPDATE tasks SET title=?,description=?,isCompleted=?,completedAt=?,priority=?,dueDate=?,dueAt=?,startDate=?,
      noteId=?,parentId=?,sortOrder=?,projectId=?,status=?,updatedAt=?,${NATIVE_TASK_REPEAT_FIELDS.map(field => `${field}=?`).join(",")} WHERE scopeKey='personal' AND id=?`, [
      task.title,task.description,task.isCompleted,task.completedAt,task.priority,task.dueDate,task.dueAt,task.startDate,
      task.noteId,task.parentId,task.sortOrder,task.projectId,task.status,updatedAt,...nativeTaskRepeatValues(task),id,
    ]);
    await enqueue("task",id,"upsert",{...task,recurrenceAction:recurrence?.action} as unknown as Record<string, unknown>,current.updatedAt);
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
  target.deleteTask = (id: string, mode = "single") => repository.removeTaskOccurrences(id,mode);
  target.stopTaskRecurrence = (id: string) => repository.removeTaskOccurrences(id,"stop");
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
    const history = await target.getTasks("history") as Task[];
    const tasks = history.filter((task) => !task.archivedAt);
    const today = dateKey(now());
    return {
      completedToday:history.filter((task) => isTaskCompletedToday(task)).length,archived:history.filter((task) => task.archivedAt).length,
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
    const reminder: Record<string, unknown> = { ...current,...patch,updatedAt:now() };
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
    const deviceOnly = isMobileLocalMode();
    if (deviceOnly) await ensureMobileLocalMindMapTree(db);
    const map = (await db.query<MindMap>(deviceOnly
      ? `SELECT m.* FROM mindmaps m LEFT JOIN mobile_local_mindmap_tree t ON t.mindmapId=m.id
         WHERE m.scopeKey='personal' AND m.id=? AND COALESCE(t.isDeleted,0)=0`
      : "SELECT * FROM mindmaps WHERE scopeKey='personal' AND id=?",[id]))[0];
    if (!map) throw new Error("思维导图不存在");return map;
  };
  target.getMindMaps = async (workspaceId?: string | null): Promise<MindMapListItem[]> => {
    if (workspaceId && workspaceId !== "personal") throw new Error("本地脑图暂不支持工作区");
    if (isMobileLocalMode()) {
      await ensureMobileLocalMindMapTree(db);
      return db.query(`SELECT m.id,m.userId,m.workspaceId,m.title,m.starred,m.folderId,m.createdAt,m.updatedAt
        FROM mindmaps m LEFT JOIN mobile_local_mindmap_tree t ON t.mindmapId=m.id
        WHERE m.scopeKey='personal' AND COALESCE(t.isDeleted,0)=0 ORDER BY m.starred DESC,m.updatedAt DESC`);
    }
    return db.query("SELECT id,userId,workspaceId,title,starred,folderId,createdAt,updatedAt FROM mindmaps WHERE scopeKey='personal' ORDER BY starred DESC,updatedAt DESC");
  };
  target.getMindMap = readMindMap;
  target.createMindMap = async (data: { title?: string; data?: string }, workspaceId?: string | null): Promise<MindMap> => {
    if (workspaceId && workspaceId !== "personal") throw new Error("本地脑图暂不支持工作区");
    const createdAt=now();const map:MindMap={id:newLocalId(),userId,workspaceId:null,title:data.title||"无标题导图",data:data.data||JSON.stringify({root:{id:"root",text:"中心主题",children:[]}}),createdAt,updatedAt:createdAt};
    await db.run("INSERT INTO mindmaps (id,scopeKey,workspaceId,userId,title,data,starred,folderId,createdAt,updatedAt) VALUES (?,'personal',NULL,?,?,?,0,NULL,?,?)",[map.id,userId,map.title,map.data,createdAt,createdAt]);
    await enqueue("mindmap",map.id,"upsert",map as unknown as Record<string, unknown>);return map;
  };
  target.updateMindMap = async (id:string,patch:Partial<MindMap>):Promise<MindMap> => {
    const current=await readMindMap(id);const map={...current,...patch,id,userId,workspaceId:null,updatedAt:now()};
    await db.run("UPDATE mindmaps SET title=?,data=?,updatedAt=? WHERE id=?",[map.title,map.data,map.updatedAt,id]);
    await enqueue("mindmap",id,"upsert",map as unknown as Record<string, unknown>,current.updatedAt);return map;
  };
  target.deleteMindMap = async (id:string)=>{
    if (isMobileLocalMode()) {
      await readMindMap(id);
      await db.run(`INSERT INTO mobile_local_mindmap_tree (mindmapId,isDeleted) VALUES (?,1)
        ON CONFLICT(mindmapId) DO UPDATE SET isDeleted=1`,[id]);
      return {success:true};
    }
    await db.run("DELETE FROM mindmaps WHERE id=?",[id]);await enqueue("mindmap",id,"delete");return {success:true};
  };
  target.deleteMindMapPermanently = async (id:string)=>{
    if (!isMobileLocalMode()) return originals.deleteMindMapPermanently(id);
    await ensureMobileLocalMindMapTree(db);
    const deleted = (await db.query<{ isDeleted: number }>(
      "SELECT isDeleted FROM mobile_local_mindmap_tree WHERE mindmapId=?", [id],
    ))[0];
    if (!deleted?.isDeleted) throw new Error("请先将脑图移入回收站");
    await db.transaction(async (tx) => {
      await tx.run("DELETE FROM mindmaps WHERE id=? AND userId=? AND scopeKey='personal'", [id,userId]);
      await tx.run("DELETE FROM mobile_local_mindmap_tree WHERE mindmapId=?", [id]);
    });
    return {success:true};
  };
  target.toggleStarMindMap = async (id:string)=>{const current=await readMindMap(id);await db.run("UPDATE mindmaps SET starred=CASE starred WHEN 1 THEN 0 ELSE 1 END WHERE id=?",[id]);return {...current,starred:(current as MindMap & { starred?: number }).starred?0:1};};
  target.getMindMapFolders = async ():Promise<MindMapFolder[]> => db.query("SELECT *,0 AS mindmapCount FROM mindmap_folders WHERE scopeKey='personal' ORDER BY sortOrder,createdAt");
  target.createMindMapFolder = async (data:Partial<MindMapFolder>)=>{const createdAt=now();const folder={id:newLocalId(),userId,workspaceId:null,parentId:data.parentId||null,name:data.name||"新建文件夹",sortOrder:data.sortOrder||0,createdAt,updatedAt:createdAt};await db.run("INSERT INTO mindmap_folders (id,scopeKey,workspaceId,userId,parentId,name,sortOrder,createdAt,updatedAt) VALUES (?,'personal',NULL,?,?,?,?,?,?)",[folder.id,userId,folder.parentId,folder.name,folder.sortOrder,createdAt,createdAt]);return folder;};
  target.updateMindMapFolder = async (id:string,patch:Partial<MindMapFolder>)=>{const current=(await db.query<MindMapFolder>("SELECT * FROM mindmap_folders WHERE id=?",[id]))[0];const folder={...current,...patch,updatedAt:now()};await db.run("UPDATE mindmap_folders SET parentId=?,name=?,sortOrder=?,updatedAt=? WHERE id=?",[folder.parentId,folder.name,folder.sortOrder,folder.updatedAt,id]);return folder;};
  target.deleteMindMapFolder = async (id:string)=>{await db.run("UPDATE mindmaps SET folderId=NULL WHERE folderId=?",[id]);await db.run("DELETE FROM mindmap_folders WHERE id=?",[id]);return {success:true};};
  target.moveMindMap = async (id:string,folderId:string|null)=>{await db.run("UPDATE mindmaps SET folderId=?,updatedAt=? WHERE id=?",[folderId,now(),id]);return readMindMap(id);};

  const assertPersonalFileScope = () => {
    if (getCurrentWorkspace() !== "personal") throw Object.assign(new Error("Native 文件中心暂不支持工作区文件，请切回个人空间或在网页端操作"), { code: "MOBILE_WORKSPACE_FILES_UNSUPPORTED" });
  };
  const fileRows = async (): Promise<Array<Record<string, unknown>>> => {
    assertPersonalFileScope();
    return db.query(`SELECT a.*,n.title AS noteTitle,n.notebookId,n.isTrashed,b.name AS notebookName,b.icon AS notebookIcon
    FROM attachments a LEFT JOIN notes n ON n.scopeKey=a.scopeKey AND n.id=a.noteId
    LEFT JOIN notebooks b ON b.scopeKey=n.scopeKey AND b.id=n.notebookId
    WHERE a.scopeKey='personal' AND a.available=1 AND a.assetTrashedAt IS NULL`);
  };
  const toFileItem = async (row:Record<string,unknown>):Promise<FileItem> => ({
    id:String(row.id),filename:String(row.filename),mimeType:String(row.mimeType),size:Number(row.size)||0,createdAt:String(row.createdAt),
    category:String(row.mimeType).startsWith("image/")?"image":"file",url:await repository.attachments.resolveUrl(String(row.id)) || "about:blank",
    hash:typeof row.hash === "string"?row.hash:null,folderId:null,folderName:null,
    primaryNote:row.noteId?{id:String(row.noteId),title:String(row.noteTitle||""),notebookId:row.notebookId?String(row.notebookId):null,notebookName:row.notebookName?String(row.notebookName):null,notebookIcon:row.notebookIcon?String(row.notebookIcon):null,isTrashed:Number(row.isTrashed)||0}:null,
  });
  const unsupportedOrganization = async () => { throw Object.assign(new Error("File tags and smart folders are not available in Native mode yet."), { code: "MOBILE_ASSET_ORGANIZATION_UNSUPPORTED" }); };
  const unsupportedVisualTools = async () => {
    assertPersonalFileScope();
    throw Object.assign(new Error("Similar-image search and batch rename are unavailable in Native mode. Use the web or desktop file center."), { code: "MOBILE_ASSET_TOOLS_UNSUPPORTED" });
  };
  target.files.tools = { similar: unsupportedVisualTools, batchRename: unsupportedVisualTools };
  target.files.organization = {
    aiPreview: unsupportedOrganization, aiConfirm: unsupportedOrganization, aiSearch: unsupportedOrganization, description: unsupportedOrganization,
    list: async () => ({ supported: false, canManageTags: false, tags: [], smartFolders: [] }),
    get: unsupportedOrganization, createTag: unsupportedOrganization, renameTag: unsupportedOrganization,
    deleteTag: unsupportedOrganization, tagFiles: unsupportedOrganization, saveSmartFolder: unsupportedOrganization, deleteSmartFolder: unsupportedOrganization,
  };
  const unsupportedTrash = async () => {
    assertPersonalFileScope();
    throw Object.assign(new Error("File recycle bin is unavailable in Native mode."), { code: "MOBILE_ASSET_TRASH_UNSUPPORTED" });
  };
  target.files.trash = { list: async () => ({ supported: false, entries: [], total: 0 }), restore: unsupportedTrash, purge: unsupportedTrash };
  target.files.prepareInsert = async (id: string, noteId: string) => {
    assertPersonalFileScope();
    const note = await target.getNote(noteId);
    const row = (await fileRows()).find((item) => item.id === id);
    if (!row || row.userId !== userId || note.userId !== userId || note.workspaceId || note.isTrashed) {
      throw Object.assign(new Error("文件与笔记不属于同一个可编辑空间"), { code: "FILE_SCOPE_MISMATCH" });
    }
    // Keep persisted content portable; the attachment bridge resolves this ID locally.
    return { ...await toFileItem(row), url: `/api/attachments/${id}` };
  };
  target.files.stats = async ():Promise<FileStats>=>{const rows=await fileRows();const images=rows.filter((row)=>String(row.mimeType).startsWith("image/"));const files=rows.filter((row)=>!String(row.mimeType).startsWith("image/"));const sum=(items:Array<Record<string,unknown>>)=>items.reduce((total,row)=>total+(Number(row.size)||0),0);const byMime=[...new Set(rows.map((row)=>String(row.mimeType)))].map((mime)=>{const items=rows.filter((row)=>row.mimeType===mime);return {mime,count:items.length,bytes:sum(items)};});return {total:rows.length,totalBytes:sum(rows),images:{count:images.length,bytes:sum(images)},files:{count:files.length,bytes:sum(files)},unreferenced:{count:0,bytes:0},myUploads:{total:rows.length,referenced:rows.length,unreferenced:0},storage:{mode:"local",driver:"local",source:"default"},byMime};};
  target.files.list = async (params:Record<string,unknown>={}):Promise<FileListResponse>=>{
    if (["tagIds", "minSize", "maxSize", "createdBefore", "referenceState", "duplicateOnly"].some((key) => params[key] !== undefined)) await unsupportedOrganization();
    let rows=await fileRows();
    if(params.category)rows=rows.filter((row)=>(String(row.mimeType).startsWith("image/")?"image":"file")===params.category);
    if(params.fileKind)rows=rows.filter((row)=>assetFileKind(String(row.mimeType))===params.fileKind);
    if(params.q)rows=rows.filter((row)=>String(row.filename).toLowerCase().includes(String(params.q).toLowerCase()));
    if(params.folderId)rows=rows.filter((row)=>params.folderId==="__unarchived"?!row.folderId:row.folderId===params.folderId);
    if(params.createdAfter)rows=rows.filter((row)=>Date.parse(String(row.createdAt))>=Date.parse(String(params.createdAfter)));
    if(params.recentDays)rows=rows.filter((row)=>Date.parse(String(row.createdAt))>=Date.now()-Number(params.recentDays)*86400000);
    const sort=String(params.sort||"created_desc");
    rows.sort((left,right)=>{
      const compare=sort.startsWith("size")?Number(left.size)-Number(right.size)
        :sort.startsWith("name")?String(left.filename).localeCompare(String(right.filename))
        :String(left.createdAt).localeCompare(String(right.createdAt));
      return sort.endsWith("_asc")?compare:-compare;
    });
    const page=Math.max(1,Number(params.page)||1),pageSize=Math.min(200,Math.max(1,Number(params.pageSize)||50)),start=(page-1)*pageSize;
    // Resolve Native binary URLs only for this page, never for the complete library.
    const items=await Promise.all(rows.slice(start,start+pageSize).map(toFileItem));
    return {items,total:rows.length,page,pageSize};
  };
  target.files.get = async (id:string):Promise<FileDetail>=>{const row=(await fileRows()).find((item)=>item.id===id);if(!row)throw new Error("文件不存在");const item=await toFileItem(row);return {...item,references:item.primaryNote?[{...item.primaryNote,updatedAt:String(row.updatedAt),isPrimary:true}]:[]};};
  target.files.upload = async (file:File):Promise<FileItem>=>{assertPersonalFileScope();const notebooks=await repository.notebooks.list();let notebook=notebooks[0];if(!notebook){const id=newLocalId();await repository.notebooks.create({id,name:"本地文件",icon:"📁"});notebook=(await repository.notebooks.get(id))!;}let holder=(await repository.notes.list({includeArchived:true,includeTrashed:true})).find((note)=>note.title==="本地文件");if(!holder){const id=newLocalId();await repository.notes.create({id,notebookId:notebook.id,title:"本地文件",isArchived:1});holder=(await repository.notes.get(id))!;}const id=newLocalId();await repository.attachments.save({id,noteId:holder.id,filename:file.name,mimeType:file.type||"application/octet-stream",blob:file});return target.files.get(id);};
  const assertSafeFileDeletion = async (id: string) => {
    assertPersonalFileScope();
    if (!isMobileLocalMode()) throw Object.assign(new Error("同步模式暂不支持文件永久删除，请在服务端文件中心检查引用后操作"), { code: "MOBILE_SYNC_FILE_DELETE_UNSUPPORTED" });
    const references = await db.query("SELECT id FROM notes WHERE content LIKE ? LIMIT 1", [`%${id}%`]);
    if (references.length) throw Object.assign(new Error("文件仍被笔记使用，请先移除引用（包括回收站中的笔记）"), { code: "FILE_IN_USE" });
  };
  target.files.remove = async (id:string)=>{await assertSafeFileDeletion(id);await repository.attachments.remove(id);return {success:true};};
  target.files.batchRemove = async (ids:string[])=>{const failed:Array<{id:string;reason:string}>=[];let deleted=0;for(const id of ids){try{await target.files.remove(id);deleted+=1;}catch(error){failed.push({id,reason:error instanceof Error?error.message:"删除失败"});}}return {success:failed.length===0,deleted,failed};};
  target.files.rename = async (id:string,filename:string)=>{assertPersonalFileScope();await db.run("UPDATE attachments SET filename=?,updatedAt=? WHERE id=?",[filename,now(),id]);const row=(await db.query<Record<string,unknown>>("SELECT * FROM attachments WHERE id=?",[id]))[0];if(row)await enqueue("attachment",id,"upsert",row);return {success:true,filename};};
  target.files.remove = unsupportedTrash;
  target.files.batchRemove = unsupportedTrash;
  target.attachmentFolders.list = async()=>({folders:[]});
  target.dataFile.cleanupOrphans = async()=>({totalRemovedItems:0,totalFreedBytes:0,removed:{databaseRows:0,contentReferences:0,diskFiles:0}});

  return () => {
    removeComposerCache();
    Object.assign(target, originals);
    target.files = originals.files;
    target.attachmentFolders = originals.attachmentFolders;
    delete target.dataFileCleanupOrphans;
    target.dataFile.cleanupOrphans = originals.dataFileCleanupOrphans;
  };
}
