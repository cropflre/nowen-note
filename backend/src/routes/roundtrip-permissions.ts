import { Hono } from "hono";
import {
  applyRoundTripPermissionMappings,
  createNowenPackageWithPermissions,
  parsePermissionsFromPackageBuffer,
  previewRoundTripPermissionMappings,
} from "../services/roundTripPermissionMapping";

const app = new Hono();

function statusOf(error: unknown): number {
  const status = Number((error as { status?: unknown })?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400;
}

function codeOf(error: unknown): string {
  return String((error as { code?: unknown })?.code || "ROUNDTRIP_PERMISSION_ERROR");
}

app.get("/package", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const workspaceId = (c.req.query("workspaceId") || "").trim();
  if (!workspaceId || workspaceId === "personal") {
    return c.json({ error: "成员权限仅适用于工作区导出", code: "WORKSPACE_REQUIRED" }, 400);
  }
  try {
    const result = await createNowenPackageWithPermissions({
      userId,
      workspaceId,
      notebookId: (c.req.query("notebookId") || "").trim() || undefined,
      includeSubNotebooks: c.req.query("includeSubNotebooks") !== "false",
      includeTrashed: c.req.query("includeTrashed") === "true",
    });
    return new Response(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(result.filename)}"`,
        "X-Export-Notes": String(result.stats.notes),
        "X-Export-Attachments": String(result.stats.attachments),
        "X-Export-Warnings": String(result.stats.warnings),
        "X-Export-Permissions": "included",
      },
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error), code: codeOf(error) }, statusOf(error) as any);
  }
});

app.post("/preview", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  try {
    const body = await c.req.json() as { workspaceId?: string; manifest?: unknown };
    const workspaceId = String(body.workspaceId || "").trim();
    if (!workspaceId) return c.json({ error: "缺少目标工作区", code: "WORKSPACE_REQUIRED" }, 400);
    const suggestions = await previewRoundTripPermissionMappings(userId, workspaceId, body.manifest);
    return c.json({ success: true, suggestions });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error), code: codeOf(error) }, statusOf(error) as any);
  }
});

app.post("/preview-package", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  try {
    const form = await c.req.formData();
    const workspaceId = String(form.get("workspaceId") || "").trim();
    const file = form.get("file");
    if (!workspaceId) return c.json({ error: "缺少目标工作区", code: "WORKSPACE_REQUIRED" }, 400);
    if (!(file instanceof File)) return c.json({ error: "缺少导入包", code: "FILE_REQUIRED" }, 400);
    const manifest = await parsePermissionsFromPackageBuffer(Buffer.from(await file.arrayBuffer()));
    if (!manifest) return c.json({ success: true, included: false, suggestions: [] });
    const suggestions = await previewRoundTripPermissionMappings(userId, workspaceId, manifest);
    return c.json({ success: true, included: true, manifest, suggestions });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error), code: codeOf(error) }, statusOf(error) as any);
  }
});

app.post("/apply", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  try {
    const body = await c.req.json() as {
      workspaceId?: string;
      manifest?: unknown;
      mappings?: Array<{ sourceUserId: string; targetUserId: string; role?: "admin" | "editor" | "viewer" }>;
    };
    const workspaceId = String(body.workspaceId || "").trim();
    if (!workspaceId) return c.json({ error: "缺少目标工作区", code: "WORKSPACE_REQUIRED" }, 400);
    const result = await applyRoundTripPermissionMappings({
      actorUserId: userId,
      workspaceId,
      manifest: body.manifest,
      mappings: body.mappings || [],
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error), code: codeOf(error) }, statusOf(error) as any);
  }
});

export default app;
