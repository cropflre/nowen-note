import { Hono } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import { callAIChat } from "../services/ai-client";
import { getUserAISettingsAsync } from "../services/user-ai-settings";

type WorkspaceRole = "owner" | "admin" | "editor" | "commenter" | "viewer";

interface TaskAIBreakdownRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string;
  dueDate: string | null;
  dueAt: string | Date | null;
}

interface ExistingChildRow {
  title: string;
  priority: number;
  dueDate: string | null;
}

function dueAtDatePart(value: string | Date | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).split("T")[0] || null;
}

export function createTaskAIBreakdownRuntimeRouter(adapter: DatabaseAdapter) {
  const app = new Hono();

  async function workspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const row = await adapter.queryOne<{ role: string }>(
      `SELECT role FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?`,
      [workspaceId, userId],
    );
    const role = row?.role;
    return role === "owner" || role === "admin" || role === "editor" || role === "commenter" || role === "viewer"
      ? role
      : null;
  }

  async function canManageTask(task: TaskAIBreakdownRow, actorId: string): Promise<boolean> {
    if (!actorId) return false;
    if (task.userId === actorId) return true;
    if (!task.workspaceId) return false;
    const role = await workspaceRole(task.workspaceId, actorId);
    return role === "owner" || role === "admin";
  }

  app.post("/:id/ai-breakdown", async (c) => {
    const userId = c.req.header("X-User-Id") || "";
    if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, 401);

    const id = c.req.param("id");
    const task = await adapter.queryOne<TaskAIBreakdownRow>(
      `SELECT id, "userId", "workspaceId", title, "dueDate", "dueAt"
         FROM tasks
        WHERE id = ?`,
      [id],
    );
    if (!task) return c.json({ error: "Task not found" }, 404);
    if (!(await canManageTask(task, userId))) {
      return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
    }

    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const lang = typeof body.lang === "string" && body.lang ? body.lang : "zh-CN";
    const settings = await getUserAISettingsAsync(userId, adapter);
    if (!settings.ai_api_url) {
      return c.json({ error: "AI not configured", code: "AI_NOT_CONFIGURED" }, 400);
    }

    const existingChildren = await adapter.queryMany<ExistingChildRow>(
      `SELECT title, priority, "dueDate"
         FROM tasks
        WHERE "parentId" = ?
        ORDER BY "sortOrder" ASC, "createdAt" ASC`,
      [id],
    );
    const existingList = existingChildren.map((child) => child.title).join(", ");

    const isZh = lang.toLowerCase().startsWith("zh");
    const systemPrompt = isZh
      ? "你是一个任务管理助手。用户会给你一个任务，你需要把它拆解成 3-8 个可执行的子任务。请严格返回 JSON 格式，不要包含其他文字。JSON 格式：{\"subtasks\":[{\"title\":\"子任务标题\",\"priority\":1或2或3,\"dueDate\":\"YYYY-MM-DD或null\",\"reason\":\"为什么这样拆\"}]}。规则：1.子任务标题要简短。2.如果有截止日期，子任务不晚于父任务。3.priority: 1=低,2=中,3=高。4.不要重复已有子任务。"
      : "You are a task management assistant. Break the given task into 3-8 actionable subtasks. Return ONLY valid JSON, no other text. JSON format: {\"subtasks\":[{\"title\":\"subtask title\",\"priority\":1,2,or3,\"dueDate\":\"YYYY-MM-DD or null\",\"reason\":\"why this breakdown\"}]}. Rules: 1.Keep titles short. 2.Subtask dueDate must not be later than parent. 3.priority: 1=low,2=medium,3=high. 4.Don't duplicate existing subtasks.";

    const userParts = [
      isZh ? `任务标题：${task.title}` : `Task title: ${task.title}`,
    ];
    if (task.dueDate) userParts.push(isZh ? `截止日期：${task.dueDate}` : `Due date: ${task.dueDate}`);
    if (task.dueAt) userParts.push(isZh ? `截止时间：${task.dueAt instanceof Date ? task.dueAt.toISOString() : task.dueAt}` : `Due time: ${task.dueAt instanceof Date ? task.dueAt.toISOString() : task.dueAt}`);
    if (existingList) userParts.push(isZh ? `已有子任务：${existingList}` : `Existing subtasks: ${existingList}`);

    try {
      const result = await callAIChat(settings, [
        { role: "system", content: systemPrompt },
        { role: "user", content: userParts.join("\n") },
      ], { temperature: 0.7, max_tokens: 2000, timeout_ms: 30000 });

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(result) as Record<string, unknown>;
      } catch {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          return c.json({ error: "AI returned invalid JSON", code: "AI_INVALID_JSON" }, 500);
        }
        try {
          parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        } catch {
          return c.json({ error: "AI returned invalid JSON", code: "AI_INVALID_JSON" }, 500);
        }
      }

      if (!Array.isArray(parsed.subtasks)) {
        return c.json({ error: "AI response missing subtasks array", code: "AI_INVALID_FORMAT" }, 500);
      }

      const validPriorities = new Set([1, 2, 3]);
      const parentDue = dueAtDatePart(task.dueAt) || task.dueDate;
      const subtasks = parsed.subtasks
        .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>).title === "string" && (value as Record<string, unknown>).title))
        .slice(0, 8)
        .map((subtask) => {
          const rawDueDate = typeof subtask.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(subtask.dueDate)
            ? subtask.dueDate
            : null;
          return {
            title: String(subtask.title).trim().slice(0, 200),
            priority: validPriorities.has(Number(subtask.priority)) ? Number(subtask.priority) : 2,
            dueDate: rawDueDate && parentDue && rawDueDate > parentDue ? parentDue : rawDueDate,
            reason: typeof subtask.reason === "string" ? subtask.reason.trim().slice(0, 200) : "",
          };
        });

      return c.json({ subtasks });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI request failed";
      return c.json({ error: message, code: "AI_REQUEST_FAILED" }, 500);
    }
  });

  return app;
}

export default createTaskAIBreakdownRuntimeRouter;
