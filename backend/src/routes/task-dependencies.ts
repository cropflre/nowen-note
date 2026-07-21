import { Hono } from "hono";
import { getDb } from "../db/schema";
import crypto from "crypto";
import { getUserWorkspaceRole, canManageResource } from "../middleware/acl";
import { taskDependenciesRepository } from "../repositories";
import { getClientMutationAt, getIdempotentMutation, getTombstone, saveIdempotentMutation, writeTombstone } from "../lib/offlineResourceSync";

const taskDependencies = new Hono();

function resolveScope(c: any, userId: string) {
  const raw = c.req.query("workspaceId");
  if (!raw || raw === "personal") return { workspaceId: null };
  const role = getUserWorkspaceRole(raw, userId);
  if (!role) return { workspaceId: raw, error: "No access to workspace" };
  return { workspaceId: raw };
}

function canAccessTombstone(
  tombstone: { userId: string; workspaceId: string | null } | undefined,
  userId: string,
): boolean {
  if (!tombstone) return false;
  if (!tombstone.workspaceId) return tombstone.userId === userId;
  const role = getUserWorkspaceRole(tombstone.workspaceId, userId);
  return role === "editor" || role === "admin" || role === "owner";
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
  const operationId = c.req.header("Idempotency-Key");
  const replay = getIdempotentMutation(db, userId, operationId);
  if (replay) return c.json(replay, 200);
  const clientUpdatedAt = getClientMutationAt(c.req.header("X-Client-Mutation-At"));
  const body = await c.req.json();
  const { predecessorTaskId, successorTaskId, type = "finish_to_start" } = body;
  const requestedId = typeof body.id === "string" ? body.id : "";
  if (requestedId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId)) {
    return c.json({ error: "Invalid dependency id", code: "INVALID_DEPENDENCY_ID" }, 400);
  }

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
    const tombstones = [
      getTombstone(db, "task", predecessorTaskId),
      getTombstone(db, "task", successorTaskId),
    ];
    if (tombstones.some((tombstone) => canAccessTombstone(tombstone, userId))) {
      return c.json({ success: true, syncIgnored: true }, 200);
    }
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

  const id = requestedId || crypto.randomUUID();
  const tombstone = getTombstone(db, "taskDependency", id);
  if (tombstone && canAccessTombstone(tombstone, userId) && clientUpdatedAt <= tombstone.deletedAt) {
    const response = { success: true, syncIgnored: true };
    saveIdempotentMutation(db, userId, operationId, response);
    return c.json(response);
  }
  const existing = taskDependenciesRepository.getById(id);
  if (existing) {
    if (existing.userId !== userId || existing.predecessorTaskId !== predecessorTaskId || existing.successorTaskId !== successorTaskId || existing.type !== type) {
      return c.json({ error: "Dependency id already exists", code: "DEPENDENCY_ID_CONFLICT" }, 409);
    }
    saveIdempotentMutation(db, userId, operationId, existing);
    return c.json(existing, 200);
  }

  // Check for duplicate
  if (taskDependenciesRepository.exists(predecessorTaskId, successorTaskId, type)) {
    return c.json({ error: "Dependency already exists" }, 409);
  }

  // Cycle detection
  if (wouldCreateCycle(db, predecessorTaskId, successorTaskId, wsId)) {
    return c.json({ error: "Circular dependency is not allowed", code: "DEPENDENCY_CYCLE" }, 400);
  }
  const created = db.transaction(() => {
    taskDependenciesRepository.create({ id, userId, workspaceId: wsId, predecessorTaskId, successorTaskId, type });
    const dependency = taskDependenciesRepository.getById(id);
    saveIdempotentMutation(db, userId, operationId, dependency);
    return dependency;
  })();
  return c.json(created, 201);
});

taskDependencies.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const depId = c.req.param("id");
  const operationId = c.req.header("Idempotency-Key");
  const replay = getIdempotentMutation(db, userId, operationId);
  if (replay) return c.json(replay, 200);
  const clientUpdatedAt = getClientMutationAt(c.req.header("X-Client-Mutation-At"));

  const dep = taskDependenciesRepository.getById(depId);
  if (!dep) {
    const tombstone = getTombstone(db, "taskDependency", depId);
    if (canAccessTombstone(tombstone, userId)) {
      const response = { success: true, syncIgnored: true };
      saveIdempotentMutation(db, userId, operationId, response);
      return c.json(response);
    }
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

  const response = { success: true };
  db.transaction(() => {
    taskDependenciesRepository.delete(depId);
    writeTombstone(db, "taskDependency", depId, dep.userId, dep.workspaceId, clientUpdatedAt);
    saveIdempotentMutation(db, userId, operationId, response);
  })();
  return c.json(response);
});

export default taskDependencies;
