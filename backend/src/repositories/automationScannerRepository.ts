import { booleanValue } from "../db/dialect";
import { getDatabaseAdapter, getDatabaseDialect } from "../db/runtime";

export interface DependencyReadyTaskRecord {
  successorTaskId: string;
  succTitle: string;
  userId: string;
}

export interface OverdueTaskCandidateRecord {
  id: string;
  title: string;
  userId: string;
  dueAt: string | null;
  dueDate: string | null;
}

/** Read-only candidate queries for the background automation scanner. */
export const automationScannerRepository = {
  async listDependencyReadyTasksAsync(): Promise<DependencyReadyTaskRecord[]> {
    const dialect = getDatabaseDialect();
    return getDatabaseAdapter().queryMany<DependencyReadyTaskRecord>(
      `SELECT DISTINCT
         succ.id AS "successorTaskId",
         succ.title AS "succTitle",
         succ."userId" AS "userId"
       FROM task_dependencies d
       JOIN tasks succ ON succ.id = d."successorTaskId"
       WHERE d.type = 'finish_to_start'
         AND succ."isCompleted" = ?
         AND NOT EXISTS (
           SELECT 1
           FROM task_dependencies d2
           JOIN tasks pred2 ON pred2.id = d2."predecessorTaskId"
           WHERE d2."successorTaskId" = d."successorTaskId"
             AND d2.type = 'finish_to_start'
             AND pred2."isCompleted" != ?
         )`,
      [booleanValue(false, dialect), booleanValue(true, dialect)],
    );
  },

  async listOverdueCandidatesAsync(): Promise<OverdueTaskCandidateRecord[]> {
    const dialect = getDatabaseDialect();
    return getDatabaseAdapter().queryMany<OverdueTaskCandidateRecord>(
      `SELECT id, title, "userId", "dueAt", "dueDate"
       FROM tasks
       WHERE "isCompleted" = ?
         AND ("dueAt" IS NOT NULL OR "dueDate" IS NOT NULL)`,
      [booleanValue(false, dialect)],
    );
  },
};
