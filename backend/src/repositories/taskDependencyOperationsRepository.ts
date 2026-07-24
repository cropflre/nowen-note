import { getDatabaseAdapter } from "../db/runtime";

export interface DependencyTaskScopeRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
}

/** Cross-table task lookups required by dependency validation. */
export const taskDependencyOperationsRepository = {
  async getTaskScopeByIdAsync(taskId: string): Promise<DependencyTaskScopeRecord | undefined> {
    return getDatabaseAdapter().queryOne<DependencyTaskScopeRecord>(
      'SELECT id, "userId", "workspaceId" FROM tasks WHERE id = ?',
      [taskId],
    );
  },
};
