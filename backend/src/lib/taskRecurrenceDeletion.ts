import type Database from "better-sqlite3";
import { SyncError } from "../sync/errors.js";
import { generateNextRepeatedTask, taskRecurrenceScope } from "./taskRecurrence.js";
export { guardTaskRecurrenceWrite, taskRecurrenceState } from "./taskRecurrence.js";

export type TaskRemovalMode = "single" | "stop" | "series";
export type TaskScope = { id: string; userId: string; workspaceId: string | null; repeatGroupId?: string | null };
export function taskSeriesRows(db: Database.Database, task: TaskScope): any[] {
  const group = task.repeatGroupId || task.id;
  return db.prepare(`SELECT * FROM tasks WHERE (id=? OR repeatGroupId=?) AND workspaceId IS ?
    AND (? IS NOT NULL OR userId=?)`).all(group,group,task.workspaceId,task.workspaceId,task.userId);
}
export function taskRemovalRows(db: Database.Database, task: TaskScope, mode: TaskRemovalMode): any[] {
  const roots = mode === "single" ? [task] : taskSeriesRows(db,task);
  if (mode === "stop") return roots;
  const rows = new Map<string, any>();
  const pending = [...roots];
  while (pending.length) {
    const row = pending.pop()!;
    if (rows.has(row.id)) continue;
    rows.set(row.id,row);
    pending.push(...db.prepare("SELECT * FROM tasks WHERE parentId=?").all(row.id));
  }
  return [...rows.values()];
}
/** Caller holds the transaction and authorizes every affected row before writing. */
export function removeTaskOccurrences(db: Database.Database, task: TaskScope, mode: TaskRemovalMode, generateNext = true): string[] {
  const rows = taskRemovalRows(db,task,mode);
  if (rows.some(row => row.workspaceId !== task.workspaceId || (!task.workspaceId && row.userId !== task.userId))) {
    throw new SyncError("SCOPE_FORBIDDEN", "任务树的作用域不一致");
  }
  const groupId = task.repeatGroupId || task.id;
  if (mode !== "single") {
    db.prepare(`INSERT INTO task_recurrence_state(groupId,scopeKey,action,updatedAt) VALUES(?,?,?,?)
      ON CONFLICT(groupId,scopeKey) DO UPDATE SET action=CASE WHEN action='series' THEN action ELSE excluded.action END,updatedAt=excluded.updatedAt`)
      .run(groupId,taskRecurrenceScope(task),mode,new Date().toISOString());
  }
  if (mode === "stop") {
    for (const row of rows) db.prepare(`UPDATE tasks SET repeatRule='none',repeatEndDate=NULL,repeatEndCount=NULL,
      repeatRuleJson=NULL,repeatGroupId=?,updatedAt=? WHERE id=?`).run(groupId,new Date().toISOString(),row.id);
  } else {
    if (mode === "single" && generateNext) {
      const current = db.prepare("SELECT * FROM tasks WHERE id=?").get(task.id) as any;
      if (current && !current.isCompleted) generateNextRepeatedTask(db,current);
    }
    // Explicitly delete descendants as well: Native SQLite does not have the same parent FK.
    for (const row of rows.reverse()) {
      db.prepare("INSERT OR REPLACE INTO task_deletion_tombstones(id,userId,workspaceId,repeatGroupId,deletedAt) VALUES(?,?,?,?,?)")
        .run(row.id,row.userId,row.workspaceId,row.repeatGroupId || null,new Date().toISOString());
      db.prepare("DELETE FROM task_dependencies WHERE predecessorTaskId=? OR successorTaskId=?").run(row.id,row.id);
      db.prepare("DELETE FROM tasks WHERE id=?").run(row.id);
    }
  }
  return rows.map(row => row.id);
}
