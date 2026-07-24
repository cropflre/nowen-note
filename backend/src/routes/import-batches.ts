import { Hono } from "hono";
import { getUserWorkspaceRole, hasRole, isSystemAdmin } from "../middleware/acl";
import {
  getRoundTripImportBatch,
  listRoundTripImportBatches,
  RoundTripImportUndoError,
} from "../services/roundTripImportBatches";
import { undoRoundTripImportBatchWithLinks } from "../services/roundTripImportLinkUndo";
import { broadcastToUser } from "../services/realtime";

const app = new Hono();

function parseWorkspaceFilter(raw: string | undefined): string | null | undefined {
  if (raw === undefined || raw === "" || raw === "all") return undefined;
  return raw === "personal" ? null : raw;
}

app.get("/", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const workspaceId = parseWorkspaceFilter(c.req.query("workspaceId"));
  const limit = Number(c.req.query("limit"));
  return c.json({
    items: listRoundTripImportBatches(userId, {
      workspaceId,
      limit: Number.isFinite(limit) ? limit : undefined,
    }),
  });
});

app.get("/:id", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const item = getRoundTripImportBatch(userId, c.req.param("id"));
  if (!item) return c.json({ error: "导入批次不存在", code: "IMPORT_BATCH_NOT_FOUND" }, 404);
  return c.json(item);
});

app.post("/:id/undo", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const batchId = c.req.param("id");
  const existing = getRoundTripImportBatch(userId, batchId);
  if (!existing) return c.json({ error: "导入批次不存在", code: "IMPORT_BATCH_NOT_FOUND" }, 404);
  if (
    existing.workspaceId
    && !isSystemAdmin(userId)
    && !hasRole(getUserWorkspaceRole(existing.workspaceId, userId), "editor")
  ) {
    return c.json({ error: "当前已无权修改该工作区，不能撤销历史导入", code: "WORKSPACE_FORBIDDEN" }, 403);
  }

  try {
    const item = await undoRoundTripImportBatchWithLinks(userId, batchId);
    try {
      broadcastToUser(userId, {
        type: "notes:imported",
        payload: {
          reason: "import-batch-undone",
          batchId: item.id,
          workspaceId: item.workspaceId,
        },
      } as any);
      broadcastToUser(userId, { type: "notebooks:changed", payload: {} } as any);
    } catch { /* refresh is best effort */ }
    return c.json(item);
  } catch (error) {
    if (error instanceof RoundTripImportUndoError) {
      return c.json({
        error: error.message,
        code: error.code,
        conflicts: error.conflicts,
      }, error.status);
    }
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, code: "IMPORT_BATCH_UNDO_FAILED" }, 500);
  }
});

export default app;
