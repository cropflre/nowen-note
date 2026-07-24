import { Hono } from "hono";
import crypto from "crypto";
import { getUserWorkspaceRole } from "../middleware/acl";
import {
  taskDependenciesRepository,
  taskDependencyOperationsRepository,
} from "../repositories";

const taskDependencies = new Hono();

function resolveScope(c: any, userId: string) {
  const raw = c.req.query("workspaceId");
  if (!raw || raw === "personal") return { workspaceId: null };
  const role = getUserWorkspaceRole(raw, userId);
  if (!role) return { workspaceId: raw, error: "No access to workspace" };
  return { workspaceId: raw };
}

// Check if adding predecessor -> successor would create a cycle
async function wouldCreateCycle(
  predecessorId: string,
  successorId: string,
): Promise<boolean> {
  // Forward BFS: from successorId, follow successor edges to see if we reach predecessorId.
  // If yes, adding predecessorId->successorId would create a cycle.
  const visited = new Set<string>();
  const queue = [successorId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === predecessorId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const nexts = await taskDependenciesRepository.listSuccessorsAsync(current);
    for (const next of nexts) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return false;
}

taskDependencies.get("/", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const scope = resolveScope(c, userId);
  if (scope.error) return c.json({ error: scope.error }, 403);

  const taskId = c.req.query("taskId");
  const rows = taskId
    ? await taskDependenciesRepository.listByTaskAsync(taskId, userId, scope.workspaceId)
    : await taskDependenciesRepository.listByWorkspaceAsync(userId, scope.workspaceId);

  return c.json(rows);
});

taskDependencies.post("/", async (c) => {
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

  // Both tasks must exist.
  const [predecessor, successor] = await Promise.all([
    taskDependencyOperationsRepository.getTaskScopeByIdAsync(predecessorTaskId),
    taskDependencyOperationsRepository.getTaskScopeByIdAsync(successorTaskId),
  ]);
  if (!predecessor || !successor) {
    return c.json({ error: "Task not found" }, 404);
  }

  // Same scope check.
  if (predecessor.workspaceId !== successor.workspaceId) {
    return c.json({ error: "Tasks must be in the same scope" }, 400);
  }

  // Permission check: must be able to manage both tasks.
  const workspaceId = predecessor.workspaceId;
  if (workspaceId) {
    const role = getUserWorkspaceRole(workspaceId, userId);
    if (!role || role === "viewer" || role === "commenter") {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
  } else if (predecessor.userId !== userId || successor.userId !== userId) {
    return c.json({ error: "No permission" }, 403);
  }

  if (await taskDependenciesRepository.existsAsync(predecessorTaskId, successorTaskId, type)) {
    return c.json({ error: "Dependency already exists" }, 409);
  }

  if (await wouldCreateCycle(predecessorTaskId, successorTaskId)) {
    return c.json({ error: "Circular dependency is not allowed", code: "DEPENDENCY_CYCLE" }, 400);
  }

  const id = crypto.randomUUID();
  await taskDependenciesRepository.createAsync({
    id,
    userId,
    workspaceId,
    predecessorTaskId,
    successorTaskId,
    type,
  });

  const created = await taskDependenciesRepository.getByIdAsync(id);
  return c.json(created, 201);
});

taskDependencies.delete("/:id", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const dependencyId = c.req.param("id");

  const dependency = await taskDependenciesRepository.getByIdAsync(dependencyId);
  if (!dependency) {
    return c.json({ error: "Dependency not found" }, 404);
  }

  if (dependency.workspaceId) {
    const role = getUserWorkspaceRole(dependency.workspaceId, userId);
    if (!role || role === "viewer" || role === "commenter") {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
  } else if (dependency.userId !== userId) {
    return c.json({ error: "No permission" }, 403);
  }

  await taskDependenciesRepository.deleteAsync(dependencyId);
  return c.json({ success: true });
});

export default taskDependencies;
