import { getDatabaseAdapter } from "../db/runtime";

export interface TaskAttachmentTaskRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
}

/** Task ownership metadata used by task attachment upload/bind/delete flows. */
export const taskAttachmentOperationsRepository = {
  async getTaskByIdAsync(taskId: string): Promise<TaskAttachmentTaskRecord | undefined> {
    return getDatabaseAdapter().queryOne<TaskAttachmentTaskRecord>(
      'SELECT id, "userId", "workspaceId" FROM tasks WHERE id = ?',
      [taskId],
    );
  },
};
