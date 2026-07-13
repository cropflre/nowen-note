import { Hono } from "hono";
import crypto from "crypto";
import { getUserWorkspaceRole } from "../middleware/acl";
import {
  taskTemplateApplyRepository,
  taskTemplatesRepository,
} from "../repositories";

const taskTemplates = new Hono();

interface NormalizedTemplateItem {
  title: string;
  description: string;
  priority: number;
  relativeDueDays: number | null;
  parentIndex: number | null;
  sortOrder: number;
}

function normalizeTemplateItems(items: any[]): NormalizedTemplateItem[] {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 50).map((item, i) => ({
    title: typeof item.title === "string" ? item.title.trim().slice(0, 200) : "",
    description: typeof item.description === "string" ? item.description : "",
    priority: [1, 2, 3].includes(item.priority) ? item.priority : 2,
    relativeDueDays: typeof item.relativeDueDays === "number" ? item.relativeDueDays : null,
    parentIndex: typeof item.parentIndex === "number" && item.parentIndex >= 0 ? item.parentIndex : null,
    sortOrder: typeof item.sortOrder === "number" ? item.sortOrder : i,
  })).filter((item) => item.title.length > 0);
}

function resolveScope(c: any, userId: string) {
  const raw = c.req.query("workspaceId");
  if (!raw || raw === "personal") return { workspaceId: null };
  const role = getUserWorkspaceRole(raw, userId);
  if (!role) return { workspaceId: raw, error: "No access to workspace" };
  return { workspaceId: raw };
}

taskTemplates.get("/", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const scope = resolveScope(c, userId);
  if (scope.error) return c.json({ error: scope.error }, 403);

  const rows = await taskTemplatesRepository.listByUserAsync(userId, scope.workspaceId);
  return c.json(rows.map((row) => ({ ...row, items: JSON.parse(row.items || "[]") })));
});

taskTemplates.post("/", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const scope = resolveScope(c, userId);
  if (scope.error) return c.json({ error: scope.error }, 403);

  const body = await c.req.json();
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "Name is required", code: "INVALID_NAME" }, 400);
  }
  const items = normalizeTemplateItems(body.items);

  const id = crypto.randomUUID();
  await taskTemplatesRepository.createAsync({
    id,
    userId,
    workspaceId: scope.workspaceId,
    name: body.name.trim(),
    description: body.description || null,
    icon: body.icon || null,
    color: body.color || null,
    items,
  });

  const row = await taskTemplatesRepository.getByIdAsync(id);
  return c.json({ ...row, items: JSON.parse(row?.items || "[]") }, 201);
});

taskTemplates.put("/:id", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");
  const row = await taskTemplatesRepository.getByIdAsync(id);
  if (!row) return c.json({ error: "Not found" }, 404);

  if (row.workspaceId) {
    const role = getUserWorkspaceRole(row.workspaceId, userId);
    if (!role) return c.json({ error: "No access" }, 403);
    if (row.userId !== userId && role !== "admin" && role !== "owner") {
      return c.json({ error: "Not allowed" }, 403);
    }
  } else if (row.userId !== userId) {
    return c.json({ error: "Not allowed" }, 403);
  }

  const body = await c.req.json();
  const updates: {
    name?: string;
    description?: string | null;
    icon?: string | null;
    color?: string | null;
    items?: NormalizedTemplateItem[];
  } = {};

  if (body.name !== undefined) {
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "Name is required", code: "INVALID_NAME" }, 400);
    }
    updates.name = body.name.trim();
  }
  if (body.description !== undefined) updates.description = body.description || null;
  if (body.icon !== undefined) updates.icon = body.icon || null;
  if (body.color !== undefined) updates.color = body.color || null;
  if (body.items !== undefined) updates.items = normalizeTemplateItems(body.items);

  if (Object.keys(updates).length === 0) {
    return c.json({ ...row, items: JSON.parse(row.items || "[]") });
  }

  await taskTemplatesRepository.updateAsync(id, updates);
  const updated = await taskTemplatesRepository.getByIdAsync(id);
  return c.json({ ...updated, items: JSON.parse(updated?.items || "[]") });
});

taskTemplates.delete("/:id", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");
  const row = await taskTemplatesRepository.getByIdAsync(id);
  if (!row) return c.json({ error: "Not found" }, 404);

  if (row.workspaceId) {
    const role = getUserWorkspaceRole(row.workspaceId, userId);
    if (!role) return c.json({ error: "No access" }, 403);
    if (row.userId !== userId && role !== "admin" && role !== "owner") {
      return c.json({ error: "Not allowed" }, 403);
    }
  } else if (row.userId !== userId) {
    return c.json({ error: "Not allowed" }, 403);
  }

  await taskTemplatesRepository.deleteAsync(id);
  return c.json({ success: true });
});

taskTemplates.post("/:id/apply", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");
  const row = await taskTemplatesRepository.getByIdAsync(id);
  if (!row) return c.json({ error: "Not found" }, 404);

  if (row.workspaceId) {
    const role = getUserWorkspaceRole(row.workspaceId, userId);
    if (!role) return c.json({ error: "No access" }, 403);
  } else if (row.userId !== userId) {
    return c.json({ error: "Not allowed" }, 403);
  }

  const body = await c.req.json();
  const projectId = body.projectId || null;
  const parentId = body.parentId || null;
  const baseDateStr = body.baseDate || null;

  if (projectId) {
    const project = await taskTemplateApplyRepository.getProjectScopeByIdAsync(projectId);
    if (!project) return c.json({ error: "Project not found" }, 404);
    if (row.workspaceId) {
      if (project.workspaceId !== row.workspaceId) {
        return c.json({ error: "Project belongs to different scope" }, 403);
      }
    } else if (project.userId !== userId || project.workspaceId) {
      return c.json({ error: "Project belongs to different scope" }, 403);
    }
  }

  if (parentId) {
    const parentTask = await taskTemplateApplyRepository.getTaskScopeByIdAsync(parentId);
    if (!parentTask) return c.json({ error: "Parent task not found" }, 404);
    if (row.workspaceId) {
      if (parentTask.workspaceId !== row.workspaceId) {
        return c.json({ error: "Parent task belongs to different scope" }, 403);
      }
    } else if (parentTask.userId !== userId || parentTask.workspaceId) {
      return c.json({ error: "Parent task belongs to different scope" }, 403);
    }
  }

  const items = JSON.parse(row.items || "[]") as NormalizedTemplateItem[];
  if (items.length === 0) return c.json({ createdTasks: [] });

  const baseDate = baseDateStr ? new Date(`${baseDateStr}T00:00:00`) : null;
  const createdIds: string[] = [];
  const createdTasks: Array<{
    id: string;
    title: string;
    description: string;
    priority: number;
    dueDate: string | null;
    projectId: string | null;
    parentId: string | null;
    status: "todo";
    isCompleted: 0;
  }> = [];
  const taskRows = [];
  const now = new Date().toISOString();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.title || typeof item.title !== "string") continue;

    const taskId = crypto.randomUUID();
    let dueDate: string | null = null;
    if (baseDate && typeof item.relativeDueDays === "number") {
      const date = new Date(baseDate);
      date.setDate(date.getDate() + item.relativeDueDays);
      dueDate = date.toISOString().split("T")[0];
    }

    const resolvedParentId =
      item.parentIndex !== null && item.parentIndex >= 0 && item.parentIndex < createdIds.length
        ? createdIds[item.parentIndex]
        : parentId;

    const description = typeof item.description === "string" ? item.description : "";
    const title = item.title.trim();
    const priority = item.priority || 2;
    const sortOrder = item.sortOrder || i;

    taskRows.push({
      id: taskId,
      userId,
      workspaceId: row.workspaceId || null,
      title,
      description,
      priority,
      sortOrder,
      projectId,
      parentId: resolvedParentId,
      dueDate,
      createdAt: now,
      updatedAt: now,
    });
    createdIds.push(taskId);
    createdTasks.push({
      id: taskId,
      title,
      description,
      priority,
      dueDate,
      projectId,
      parentId: resolvedParentId,
      status: "todo",
      isCompleted: 0,
    });
  }

  await taskTemplateApplyRepository.createTasksAsync(taskRows);
  return c.json({ createdTasks, count: createdTasks.length });
});

export default taskTemplates;
