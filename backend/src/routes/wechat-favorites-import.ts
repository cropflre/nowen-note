import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { Hono } from "hono";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole, hasRole, isSystemAdmin } from "../middleware/acl";
import { broadcastToUser } from "../services/realtime";
import {
  importWeChatFavoritesPackageFromZipFile,
  WeChatFavoritesPackageError,
  type WeChatDuplicateStrategy,
} from "../services/wechatFavoritesPackageImport";

const Busboy = require("busboy");
const router = new Hono();
const TMP_PREFIX = "nowen-wechat-favorites-import-";
const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UPLOAD_BYTES = (() => {
  const raw = Number(process.env.WECHAT_FAVORITES_IMPORT_MAX_UPLOAD_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_UPLOAD_BYTES;
})();
const STALE_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
let lastCleanupAt = 0;

class UploadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 413 = 400,
  ) {
    super(message);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.ceil(bytes / 1024 / 1024)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

async function cleanupStaleTmpDirs(): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  try {
    const entries = await fs.promises.readdir(os.tmpdir(), { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(TMP_PREFIX))
      .map(async (entry) => {
        const target = path.join(os.tmpdir(), entry.name);
        try {
          const stat = await fs.promises.stat(target);
          if (now - stat.mtimeMs >= STALE_AGE_MS) {
            await fs.promises.rm(target, { recursive: true, force: true });
          }
        } catch { /* best effort */ }
      }));
  } catch { /* best effort */ }
}

async function receivePackage(c: any): Promise<{
  tmpDir: string;
  tmpPath: string;
  filename: string;
  fields: Record<string, string>;
}> {
  await cleanupStaleTmpDirs();
  const contentType = c.req.header("content-type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new UploadError("请使用 multipart/form-data 上传 ZIP 文件", "WECHAT_MULTIPART_REQUIRED");
  }
  const declaredLength = Number(c.req.header("content-length") || 0);
  if (declaredLength > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      `微信收藏导入包过大，最大支持 ${formatBytes(MAX_UPLOAD_BYTES)}`,
      "WECHAT_UPLOAD_TOO_LARGE",
      413,
    );
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  const tmpPath = path.join(tmpDir, "package.zip");
  const fields: Record<string, string> = {};

  return await new Promise<{ tmpDir: string; tmpPath: string; filename: string; fields: Record<string, string> }>((resolve, reject) => {
    let filename = "wechat-favorites.zip";
    let size = 0;
    let fileSeen = false;
    let output: fs.WriteStream | null = null;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      try { output?.destroy(); } catch { /* ignore */ }
      reject(error);
    };

    let busboy: any;
    try {
      busboy = Busboy({
        headers: Object.fromEntries(c.req.raw.headers.entries()),
        limits: { files: 1, fileSize: MAX_UPLOAD_BYTES, fields: 20, fieldSize: 128 * 1024 },
      });
    } catch {
      fail(new UploadError("multipart 请求格式无效", "WECHAT_MULTIPART_INVALID"));
      return;
    }

    busboy.on("field", (name: string, value: string) => {
      if (name && typeof value === "string") fields[name] = value;
    });
    busboy.on("file", (name: string, stream: any, info: any) => {
      if (name !== "file" || fileSeen) {
        stream.resume();
        return;
      }
      fileSeen = true;
      filename = String(info?.filename || filename).slice(0, 255);
      if (!filename.toLowerCase().endsWith(".zip")) {
        stream.resume();
        fail(new UploadError("仅支持 .zip 微信收藏导入包", "WECHAT_ZIP_REQUIRED"));
        return;
      }
      output = fs.createWriteStream(tmpPath, { flags: "wx" });
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) {
          stream.unpipe(output!);
          stream.resume();
          fail(new UploadError(
            `微信收藏导入包过大，最大支持 ${formatBytes(MAX_UPLOAD_BYTES)}`,
            "WECHAT_UPLOAD_TOO_LARGE",
            413,
          ));
        }
      });
      stream.on("limit", () => fail(new UploadError(
        `微信收藏导入包过大，最大支持 ${formatBytes(MAX_UPLOAD_BYTES)}`,
        "WECHAT_UPLOAD_TOO_LARGE",
        413,
      )));
      stream.on("error", fail);
      output.on("error", fail);
      stream.pipe(output);
    });
    busboy.on("filesLimit", () => fail(new UploadError("每次只能上传一个 ZIP 文件", "WECHAT_TOO_MANY_FILES")));
    busboy.on("error", fail);
    busboy.on("finish", async () => {
      if (settled) return;
      if (!fileSeen) {
        fail(new UploadError("缺少 file 字段", "WECHAT_FILE_REQUIRED"));
        return;
      }
      try {
        await new Promise<void>((done, error) => {
          if (!output || output.closed) return done();
          output.once("close", () => done());
          output.once("error", error);
        });
        const stat = await fs.promises.stat(tmpPath);
        if (!stat.size) throw new UploadError("上传的 ZIP 文件为空", "WECHAT_ZIP_EMPTY");
        settled = true;
        resolve({ tmpDir, tmpPath, filename, fields });
      } catch (error) {
        fail(error as Error);
      }
    });

    const body = c.req.raw.body;
    if (!body) {
      fail(new UploadError("上传请求体为空", "WECHAT_BODY_EMPTY"));
      return;
    }
    Readable.fromWeb(body as any).on("error", fail).pipe(busboy);
  }).catch(async (error) => {
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw error;
  });
}

function normalizeWorkspace(value: string | undefined): string | null {
  const raw = String(value || "").trim();
  return !raw || raw === "personal" ? null : raw;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "1" || value === "true" || value === "yes";
}

function parseConfig(fields: Record<string, string>): {
  rootNotebookName: string;
  groupByYear: boolean;
  preserveTags: boolean;
  continueOnMissingMedia: boolean;
  duplicateStrategy: WeChatDuplicateStrategy;
  selectedTypes: string[];
} {
  let config: Record<string, unknown> = {};
  if (fields.config) {
    try {
      const parsed = JSON.parse(fields.config);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
    } catch {
      throw new UploadError("config JSON 格式无效", "WECHAT_CONFIG_INVALID");
    }
  }
  const duplicateStrategy = String(config.duplicateStrategy || fields.duplicateStrategy || "skip") as WeChatDuplicateStrategy;
  if (!["skip", "update", "duplicate"].includes(duplicateStrategy)) {
    throw new UploadError("duplicateStrategy 必须是 skip、update 或 duplicate", "WECHAT_CONFIG_INVALID");
  }
  const selectedTypes = Array.isArray(config.selectedTypes)
    ? config.selectedTypes.map(String).filter(Boolean).slice(0, 100)
    : String(fields.selectedTypes || "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 100);
  return {
    rootNotebookName: String(config.rootNotebookName || fields.rootNotebookName || "微信收藏").slice(0, 60),
    groupByYear: typeof config.groupByYear === "boolean" ? config.groupByYear : parseBoolean(fields.groupByYear, true),
    preserveTags: typeof config.preserveTags === "boolean" ? config.preserveTags : parseBoolean(fields.preserveTags, true),
    continueOnMissingMedia: typeof config.continueOnMissingMedia === "boolean"
      ? config.continueOnMissingMedia
      : parseBoolean(fields.continueOnMissingMedia, true),
    duplicateStrategy,
    selectedTypes,
  };
}

router.post("/import-wechat-favorites-package", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const workspaceId = normalizeWorkspace(c.req.query("workspaceId"));
  const dryRun = c.req.query("dryRun") === "1" || c.req.query("dryRun") === "true";
  if (!userId) return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);

  if (workspaceId) {
    const role = getUserWorkspaceRole(workspaceId, userId);
    if (!isSystemAdmin(userId) && !hasRole(role, "editor")) {
      return c.json({ error: "无权导入到该工作区", code: "WORKSPACE_FORBIDDEN" }, 403);
    }
  } else {
    const user = getDb().prepare("SELECT personalImportEnabled FROM users WHERE id = ?").get(userId) as
      | { personalImportEnabled?: number }
      | undefined;
    if (user && user.personalImportEnabled === 0) {
      return c.json({ error: "个人空间导入功能已被管理员关闭", code: "PERSONAL_IMPORT_DISABLED" }, 403);
    }
  }

  let uploaded: Awaited<ReturnType<typeof receivePackage>> | null = null;
  try {
    uploaded = await receivePackage(c);
    const config = parseConfig(uploaded.fields);
    const result = await importWeChatFavoritesPackageFromZipFile(uploaded.tmpPath, {
      userId,
      workspaceId,
      dryRun,
      ...config,
    });
    if (!dryRun && result.success) {
      broadcastToUser(userId, {
        type: "notes:imported" as any,
        count: result.counts.imported + result.counts.updated + result.counts.partial,
        notebookIds: result.rootNotebookId ? [result.rootNotebookId] : [],
        workspaceId,
      });
      broadcastToUser(userId, { type: "notebooks:changed", payload: {} } as any);
    }
    return c.json(result, dryRun ? 200 : 201);
  } catch (error) {
    if (error instanceof UploadError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof WeChatFavoritesPackageError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    console.error("[wechat-favorites-import.route]", error);
    return c.json({ error: (error as Error)?.message || "微信收藏导入失败", code: "WECHAT_IMPORT_FAILED" }, 500);
  } finally {
    if (uploaded?.tmpDir) {
      try { await fs.promises.rm(uploaded.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

export default router;
