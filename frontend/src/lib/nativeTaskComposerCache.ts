import type { NativeDatabase } from "./nativeDatabase";
import type { Task, TaskProject } from "@/types";
import { NATIVE_TASK_REPEAT_FIELDS, nativeTaskRepeatValues } from "./nativeTaskFields";
import { ensureMobileLocalTaskSchema } from "./mobileLocalAdvancedTaskBridge";

export async function cacheConfirmedNativeTasks(db: NativeDatabase, userId: string, tasks: Task[], projects: TaskProject[] = []): Promise<void> {
  if (projects.length) await ensureMobileLocalTaskSchema(db);
  await db.transaction(async tx => {
    for (const project of projects) {
      if (project.workspaceId) continue;
      await tx.run("INSERT OR IGNORE INTO mobile_local_task_projects(id,userId,name,icon,color,sortOrder,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)", [project.id,userId,project.name,project.icon || "",project.color || "",project.sortOrder || 0,project.createdAt,project.updatedAt]);
    }
    for (const task of tasks) {
      if (task.workspaceId) continue;
      const deleted = await tx.query("SELECT id FROM task_deletion_tombstones WHERE id=?",[task.id]);
      const lifecycle = (await tx.query<{action:string}>("SELECT action FROM task_recurrence_state WHERE groupId=? AND scopeKey=?",[task.repeatGroupId || task.id,`personal:${userId}`]))[0];
      if (deleted.length || lifecycle?.action === "series") continue;
      const repeatTask = lifecycle?.action === "stop" ? {...task,repeatRule:"none" as const} : task;
      // A retry must not overwrite edits or recreate Outbox mutations for an existing local row.
      await tx.run(`INSERT OR IGNORE INTO tasks (
        id,scopeKey,workspaceId,userId,title,description,isCompleted,completedAt,priority,dueDate,dueAt,startDate,
        noteId,parentId,sortOrder,projectId,status,createdAt,updatedAt,${NATIVE_TASK_REPEAT_FIELDS.join(",")}
      ) VALUES (?,'personal',NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${NATIVE_TASK_REPEAT_FIELDS.map(() => "?").join(",")})`, [
        task.id,userId,task.title,task.description || "",task.isCompleted,task.completedAt || null,task.priority,
        task.dueDate || null,task.dueAt || null,task.startDate || null,null,null,task.sortOrder || 0,
        task.projectId || null,task.status || "todo",task.createdAt,task.updatedAt,...nativeTaskRepeatValues(repeatTask),
      ]);
    }
  });
}
