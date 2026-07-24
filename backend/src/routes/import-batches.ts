import { Hono } from "hono";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole, hasRole, isSystemAdmin } from "../middleware/acl";
import {
  getRoundTripImportBatch,
  listRoundTripImportBatches,
  RoundTripImportUndoError,
} from "../services/roundTripImportBatches";
import { undoRoundTripImportBatchWithLinksAndPermissions } from "../services/roundTripImportPermissionUndo";
import { canManageRoundTripPermissions } from "../services/roundTripPermissionTransfer";
import { broadcastToUser } from "../services/realtime";

const app = new Hono();

function parseWorkspaceFilter(raw: string | undefined): string | null | undefined {
  if (raw === undefined || raw === "" || raw === "all") return undefined;
  return raw === "personal" ? null : raw;
}

function parsePackageWorkspace(raw: string | undefined): string | null {
  const value = String(raw || "").trim();
  return !value || value === "personal" ? null : value;
}

function personalFeatureDisabled(
  userId: string,
  workspaceId: string | null,
  column: "personalExportEnabled" | "personalImportEnabled",
): boolean {
  if (workspaceId || isSystemAdmin(userId)) return false;
  const row = getDb().prepare(`SELECT ${column} AS enabled FROM users WHERE id = ?`).get(userId) as
    | { enabled: number }
    | undefined;
  return row?.enabled === 0;
}

function errorStatus(error: unknown): number {
  const value = Number((error as { status?: unknown })?.status);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}

app.get("/package", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const workspaceId = parsePackageWorkspace(c.req.query("workspaceId"));
  const includePermissions = c.req.query("includePermissions") === "true";
  if (personalFeatureDisabled(userId, workspaceId, "personalExportEnabled")) {
    return c.json({ error: "管理员已禁用你的个人空间导出功能", code: "FEATURE_DISABLED" }, 403);
  }
  if (includePermissions && !workspaceId) {
    return c.json({ error: "成员与权限只能随工作区 Nowen 无损包导出", code: "PERMISSION_EXPORT_REQUIRES_WORKSPACE" }, 400);
  }
  if (includePermissions && !canManageRoundTripPermissions(userId, workspaceId)) {
    return c.json({ error: "只有工作区 owner/admin 可以导出成员与权限清单", code: "PERMISSION_EXPORT_FORBIDDEN" }, 403);
  }

  try {
    const { createStableNowenPackageExport } = await import("../services/nowenPackageExportStable");
    const result = await createStableNowenPackageExport({
      userId,
      workspaceId,
      notebookId: c.req.query("notebookId") || undefined,
      includeSubNotebooks: c.req.query("includeSubNotebooks") !== "false",
      includeTrashed: c.req.query("includeTrashed") === "true",
      includePermissions,
    });
    return new Response(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(result.filename)}"`,
        "X-Export-Notes": String(result.stats.notes),
        "X-Export-Attachments": String(result.stats.attachments),
        "X-Export-Warnings": String(result.stats.warnings),
        "X-Export-Permission-Principals": String((result.stats as any).permissionPrincipals || 0),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, code: "ROUNDTRIP_EXPORT_FAILED" }, errorStatus(error) as any);
  }
});

app.post("/package", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const workspaceId = parsePackageWorkspace(c.req.query("workspaceId"));
  const dryRun = c.req.query("dryRun") === "1" || c.req.query("dryRun") === "true";
  const importMode = (c.req.query("importMode") as "new-root" | "into-target" | "merge" | "sync") || "new-root";
  const targetNotebookId = c.req.query("targetNotebookId") || undefined;
  if (personalFeatureDisabled(userId, workspaceId, "personalImportEnabled")) {
    return c.json({ error: "管理员已禁用你的个人空间导入功能", code: "FEATURE_DISABLED" }, 403);
  }

  try {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || !(file instanceof File)) return c.json({ error: "No file uploaded", code: "NO_FILE" }, 400);
    const applyPermissions = String(body.applyPermissions || "") === "true";
    if (applyPermissions && !workspaceId) {
      return c.json({ error: "成员与权限只能恢复到工作区", code: "PERMISSION_IMPORT_REQUIRES_WORKSPACE" }, 400);
    }
    if (applyPermissions && !canManageRoundTripPermissions(userId, workspaceId)) {
      return c.json({ error: "只有目标工作区 owner/admin 可以恢复成员与权限", code: "PERMISSION_IMPORT_FORBIDDEN" }, 403);
    }

    let permissionMappings: Record<string, string> = {};
    if (typeof body.permissionMappings === "string" && body.permissionMappings.trim()) {
      try {
        const parsed = JSON.parse(body.permissionMappings) as Record<string, unknown>;
        permissionMappings = Object.fromEntries(Object.entries(parsed)
          .map(([source, target]) => [String(source || "").trim(), String(target || "").trim()])
          .filter(([source, target]) => source && target));
      } catch {
        return c.json({ error: "permissionMappings 必须是有效 JSON", code: "INVALID_PERMISSION_MAPPINGS" }, 400);
      }
    }

    const zipBuffer = Buffer.from(await file.arrayBuffer());
    const { importNowenPackage } = await import("../services/nowenPackageImport");
    const result = await importNowenPackage(zipBuffer, {
      userId,
      workspaceId,
      targetNotebookId,
      importMode,
      dryRun,
      applyPermissions,
      permissionMappings,
    });
    if (!result.success) return c.json(result, 400);

    if (!dryRun) {
      try {
        broadcastToUser(userId, {
          type: "notes:imported",
          payload: { rootNotebookId: result.rootNotebookId, counts: result.counts },
        } as any);
        broadcastToUser(userId, { type: "notebooks:changed", payload: {} } as any);
      } catch { /* best effort */ }
    }
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message, code: "ROUNDTRIP_IMPORT_FAILED" }, errorStatus(error) as any);
  }
});

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
    const item = await undoRoundTripImportBatchWithLinksAndPermissions(userId, batchId);
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
