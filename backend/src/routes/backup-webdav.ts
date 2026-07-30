import { Hono } from "hono";
import type { Context } from "hono";

import { getDb } from "../db/schema.js";
import { verifySudoFromRequest } from "../lib/auth-security.js";
import { requireAdmin } from "../middleware/acl.js";
import { logAudit } from "../services/audit.js";
import {
  clearBackupWebDavConfig,
  getBackupWebDavConfig,
  getBackupWebDavRemoteDirectory,
  saveBackupWebDavConfig,
  testBackupWebDavConnection,
  uploadBackupToWebDav,
  type BackupWebDavConfigInput,
} from "../services/backup-webdav.js";

const router = new Hono();
router.use("*", requireAdmin);

function requireSudo(c: Context): Response | null {
  const userId = c.req.header("X-User-Id") || "";
  const row = getDb()
    .prepare("SELECT tokenVersion FROM users WHERE id = ?")
    .get(userId) as { tokenVersion?: number } | undefined;
  const result = verifySudoFromRequest(c, userId, row?.tokenVersion ?? 0);
  if (result.ok) return null;
  return c.json({ error: result.message, code: result.code }, result.status as 401 | 403);
}

function errorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error || "WebDAV 操作失败");
  const status = /请填写|格式|仅支持|不能包含|同时填写|尚未启用|不存在/.test(message) ? 400 : 502;
  return c.json({ error: message }, status as 400 | 502);
}

router.get("/", (c) => {
  return c.json({
    ...getBackupWebDavConfig(),
    remoteDirectory: getBackupWebDavRemoteDirectory(),
  });
});

router.put("/", async (c) => {
  const denied = requireSudo(c);
  if (denied) return denied;
  const userId = c.req.header("X-User-Id") || "";
  const input = (await c.req.json().catch(() => ({}))) as BackupWebDavConfigInput;
  try {
    const config = saveBackupWebDavConfig(input);
    logAudit(userId, "system", "backup_webdav_config_update", {
      enabled: config.enabled,
      endpoint: config.endpoint,
      remotePath: config.remotePath,
      uploadOnAutoBackup: config.uploadOnAutoBackup,
      passwordUpdated: typeof input.password === "string" && input.password.length > 0,
    }, { targetType: "backup_webdav", targetId: "default" });
    return c.json({ ...config, remoteDirectory: getBackupWebDavRemoteDirectory() });
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.delete("/", (c) => {
  const denied = requireSudo(c);
  if (denied) return denied;
  const userId = c.req.header("X-User-Id") || "";
  const config = clearBackupWebDavConfig();
  logAudit(userId, "system", "backup_webdav_config_clear", {}, {
    targetType: "backup_webdav",
    targetId: "default",
  });
  return c.json({ ...config, remoteDirectory: null });
});

router.post("/test", async (c) => {
  const denied = requireSudo(c);
  if (denied) return denied;
  const input = (await c.req.json().catch(() => ({}))) as BackupWebDavConfigInput;
  try {
    await testBackupWebDavConnection(input);
    return c.json({
      success: true,
      message: "WebDAV 连接成功，目标目录可读写",
      config: getBackupWebDavConfig(),
      remoteDirectory: getBackupWebDavRemoteDirectory(),
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.post("/upload/:filename", async (c) => {
  const denied = requireSudo(c);
  if (denied) return denied;
  const userId = c.req.header("X-User-Id") || "";
  const filename = c.req.param("filename");
  try {
    const result = await uploadBackupToWebDav(filename);
    logAudit(userId, "system", "backup_webdav_upload", {
      filename: result.filename,
      size: result.size,
      remoteUrl: result.remoteUrl,
    }, { targetType: "backup", targetId: result.filename });
    return c.json({
      success: true,
      message: `已上传到 WebDAV：${result.filename}`,
      ...result,
    });
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default router;
