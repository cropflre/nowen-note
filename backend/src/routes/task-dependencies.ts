import { Hono } from "hono";
import { getDb } from "../db/schema";
import crypto from "crypto";
import { getUserWorkspaceRole, canManageResource } from "../middleware/acl";
import { taskDependenciesRepository } from "../repositories";

const taskDependencies = new Hono();

function resolveScope(c: any, userId: string) {
  const raw = c.req.query("workspaceId");
  if (!raw || raw === "personal") return { workspaceId: null };
  const role = getUserWorkspaceRole(raw, userId);
  if (!role) return { workspaceId: raw, error: "No access to workspace" };
  return { workspaceId: raw };
}

// Check if adding predecessor -> successor would create a cycle
function wouldCreateCycle(
  db: any,
  predecessorId: string,
  successorId: string,
  workspaceId: string | null
): boolean {
  // Forward BFS: from successorId, follow successor edges to see if we reach predecessorId.
  // If yes, adding predecessorId->successorId would create a cycle.
  const visited = new Set<string>();
  const queue = [successorId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === predecessorId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const nexts = taskDependenciesRepository.listSuccessors(current);
    for (const n of nexts) {
      if (!visited.has(n)) {
        queue.push(n);
      }
    }
  }
  return false;
}

taskDependencies.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const scope = resolveScope(c, userId);
  if (scope.error) return c.json({ error: scope.error }, 403);

  const taskId = c.req.query("taskId");

  let rows;
  if (taskId) {
    rows = taskDependenciesRepository.listByTask(taskId, userId, scope.workspaceId);
  } else {
    rows = taskDependenciesRepository.listByWorkspace(userId, scope.workspaceId);
  }

  return c.json(rows);
});

taskDependencies.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const body = await c.req.json();
  const { predecessorTaskId, successorTaskId, type = "finish_to_start" } = body;

  if (!predecessorTaskId || !successorTaskId) {
    return c.json({ error: "predecessorTaskId and successorTaskId are required" }, 400);
  }
  if (predecessorTaskId === successorTaskId) {
    return c.json({ error: "Cannot depend on self", code: "SELF_DEPENDENCY" }, 400);
  }
  if (type !== "finish_to_start") {
    return c.json({ error: "Only finish_to_start is supported in V1" }, 400);
  }

  // Both tasks must exist
  const pred = db.prepare("SELECT * FROM tasks WHERE id = ?").get(predecessorTaskId) as any;
  const succ = db.prepare("SELECT * FROM tasks WHERE id = ?").get(successorTaskId) as any;
  if (!pred || !succ) {
    return c.json({ error: "Task not found" }, 404);
  }

  // Same scope check
  if (pred.workspaceId !== succ.workspaceId) {
    return c.json({ error: "Tasks must be in the same scope" }, 400);
  }

  // Permission check: must be able to manage both tasks
  const wsId = pred.workspaceId;
  if (wsId) {
    const role = getUserWorkspaceRole(wsId, userId);
    if (!role || role === "viewer" || role === "commenter") {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
  } else {
    if (pred.userId !== userId || succ.userId !== userId) {
      return c.json({ error: "No permission" }, 403);
    }
  }

  // Check for duplicate
  if (taskDependenciesRepository.exists(predecessorTaskId, successorTaskId, type)) {
    return c.json({ error: "Dependency already exists" }, 409);
  }

  // Cycle detection
  if (wouldCreateCycle(db, predecessorTaskId, successorTaskId, wsId)) {
    return c.json({ error: "Circular dependency is not allowed", code: "DEPENDENCY_CYCLE" }, 400);
  }

  const id = crypto.randomUUID();
  taskDependenciesRepository.create({ id, userId, workspaceId: wsId, predecessorTaskId, successorTaskId, type });

  const created = taskDependenciesRepository.getById(id);
  return c.json(created, 201);
});

taskDependencies.delete("/:id", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const depId = c.req.param("id");

  const dep = taskDependenciesRepository.getById(depId);
  if (!dep) {
    return c.json({ error: "Dependency not found" }, 404);
  }

  // Permission: must be able to manage tasks
  if (dep.workspaceId) {
    const role = getUserWorkspaceRole(dep.workspaceId, userId);
    if (!role || role === "viewer" || role === "commenter") {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
  } else {
    if (dep.userId !== userId) {
      return c.json({ error: "No permission" }, 403);
    }
  }

  taskDependenciesRepository.delete(depId);
  return c.json({ success: true });
});

export default taskDependencies;
