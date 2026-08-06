import { booleanValue } from "../db/dialect";
import {
  getDatabaseAdapter,
  getDatabaseRuntimeStatus,
  resolveDatabaseRuntimeConfig,
} from "../db/runtime";

export interface TaskScopeRecord {
  userId: string;
  workspaceId: string | null;
}

export interface TemplateTaskInsert {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string;
  description: string;
  priority: number;
  sortOrder: number;
  projectId: string | null;
  parentId: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

function resolveDialect() {
  return getDatabaseRuntimeStatus().driver ?? resolveDatabaseRuntimeConfig(process.env).driver;
}

/**
 * 模板应用所需的跨表查询与批量任务写入边界。
 *
 * Route 只负责权限、日期和父子关系计算；数据库查询与事务写入全部集中在此处。
 */
export const taskTemplateApplyRepository = {
  async getProjectScopeByIdAsync(projectId: string): Promise<TaskScopeRecord | undefined> {
    return getDatabaseAdapter().queryOne<TaskScopeRecord>(
      'SELECT "userId", "workspaceId" FROM task_projects WHERE id = ?',
      [projectId],
    );
  },

  async getTaskScopeByIdAsync(taskId: string): Promise<TaskScopeRecord | undefined> {
    return getDatabaseAdapter().queryOne<TaskScopeRecord>(
      'SELECT "userId", "workspaceId" FROM tasks WHERE id = ?',
      [taskId],
    );
  },

  async createTasksAsync(tasks: TemplateTaskInsert[]): Promise<void> {
    if (tasks.length === 0) return;

    const completed = booleanValue(false, resolveDialect());
    await getDatabaseAdapter().executeBatch(
      `INSERT INTO tasks (
        id, "userId", "workspaceId", title, description, priority,
        "isCompleted", "completedAt", status, "sortOrder", "projectId",
        "parentId", "dueDate", "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'todo', ?, ?, ?, ?, ?, ?)`,
      tasks.map((task) => [
        task.id,
        task.userId,
        task.workspaceId,
        task.title,
        task.description,
        task.priority,
        completed,
        task.sortOrder,
        task.projectId,
        task.parentId,
        task.dueDate,
        task.createdAt,
        task.updatedAt,
      ]),
    );
  },
};
