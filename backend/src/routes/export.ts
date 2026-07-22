import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";
import { extractInlineBase64Images } from "./attachments";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import { broadcastToUser } from "../services/realtime";
import { getUserWorkspaceRole, hasRole, isSystemAdmin } from "../middleware/acl";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import {
  createMarkdownExportJob,
  getMarkdownExportJob,
  MarkdownExportBusyError,
  stageGeneratedExport,
  type PreparedMarkdownNote,
} from "../services/markdownExportJobs";

const Busboy = require("busboy");

const app = new Hono();
const SIYUAN_IMPORT_TMP_PREFIX = "nowen-siyuan-import-";
const SIYUAN_IMPORT_TMP_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const SIYUAN_IMPORT_TMP_STALE_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SIYUAN_IMPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const SIYUAN_IMPORT_MAX_BYTES = (() => {
  const raw = Number(process.env.SIYUAN_IMPORT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SIYUAN_IMPORT_MAX_BYTES;
})();
let lastSiyuanImportTmpCleanupAt = 0;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${bytes} bytes`;
  return `${Math.floor(bytes / 1024 / 1024)}MB`;
}

class SiyuanImportTooLargeError extends Error {
  status = 413;
  code = "SIYUAN_IMPORT_TOO_LARGE";

  constructor() {
    super(`思源导入包过大，最大支持 ${formatBytes(SIYUAN_IMPORT_MAX_BYTES)}`);
  }
}

async function cleanupStaleSiyuanImportTmpDirs(): Promise<void> {
  const now = Date.now();
  if (now - lastSiyuanImportTmpCleanupAt < SIYUAN_IMPORT_TMP_CLEANUP_INTERVAL_MS) return;
  lastSiyuanImportTmpCleanupAt = now;

  try {
    const tmpRoot = os.tmpdir();
    const entries = await fs.promises.readdir(tmpRoot, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(SIYUAN_IMPORT_TMP_PREFIX))
      .map(async (entry) => {
        const abs = path.join(tmpRoot, entry.name);
        try {
          const stat = await fs.promises.stat(abs);
          if (now - stat.mtimeMs < SIYUAN_IMPORT_TMP_STALE_AGE_MS) return;
          await fs.promises.rm(abs, { recursive: true, force: true });
        } catch {
          /* ignore stale cleanup failure */
        }
      }));
  } catch {
    /* ignore stale cleanup failure */
  }
}

/**
 * 个人空间导出/导入开关闸门（方案 B：per-user）。
 *
 * 历史（v5 及以前）：
 *   这两个开关保存在 system_settings 的 `feature_personal_export_enabled` /
 *   `feature_personal_import_enabled` 两个全局键里——"要么全站开、要么全站关"。
 *
 * 现在（v6 之后）：
 *   开关下沉为 users 表的两列（personalExportEnabled / personalImportEnabled），
 *   由管理员在「用户管理 → 编辑用户」里逐个切换。这里按目标 userId 直接读它
 *   自己的行，没有记录时按"开启"兜底（理论上 DEFAULT 1 已保证非空）。
 *
 * 设计约束：
 *  - 仅当目标是"个人空间"（workspaceFilter 解出的 param === null）时才检查；
 *    工作区的导出/导入沿用各自的成员权限语义，不受该开关影响。
 *  - 系统管理员不受开关约束（管理员需要随时具备数据救援能力，即使管理员自己的
 *    两列被误置为 0 也能兜底放行）。
 *  - 普通用户在开关关闭时返回 403，并附 code=FEATURE_DISABLED，便于前端
 *    定位文案与隐藏入口。
 */
function denyIfPersonalFeatureDisabled(
  userId: string,
  isPersonalScope: boolean,
  feature: "personalExportEnabled" | "personalImportEnabled",
): { error: string; code: string } | null {
  if (!isPersonalScope) return null;
  if (isSystemAdmin(userId)) return null;

  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT personalExportEnabled, personalImportEnabled FROM users WHERE id = ?`,
      )
      .get(userId) as
      | { personalExportEnabled: number; personalImportEnabled: number }
      | undefined;
    // 用户不存在 / 读库异常按"放行"兜底——让真正的权限问题交给上层中间件去拦，
    // 这里不要因 DB 抖动造成导出入口意外报 403。
    if (!row) return null;
    const enabled = row[feature] !== 0;
    if (enabled) return null;
  } catch {
    return null;
  }

  return {
    error:
      feature === "personalExportEnabled"
        ? "管理员已禁用你的个人空间导出功能"
        : "管理员已禁用你的个人空间导入功能",
    code: "FEATURE_DISABLED",
  };
}

/**
 * 解析 query 里的 workspaceId 为 SQLite 过滤条件。
 *   - 缺省 / "personal" → 个人空间（notes.workspaceId IS NULL）
 *   - 其它字符串       → 指定工作区（notes.workspaceId = ?）
 *
 * 返回 { sql, param }：sql 片段用于拼到 WHERE 后；param 为对应参数（NULL 时 undefined）。
 *
 * 注意：与 notes/notebooks/tasks 等业务接口的隔离语义保持一致——前端 personal 不带
 * 参数、workspace 带 `?workspaceId=<uuid>`。
 */
function workspaceFilter(raw: string | undefined): { sql: string; param: string | null } {
  const ws = (raw || "").trim();
  if (!ws || ws === "personal") {
    return { sql: "AND n.workspaceId IS NULL", param: null };
  }
  return { sql: "AND n.workspaceId = ?", param: ws };
}

function normalizeImportedContentFormat(value: unknown): "tiptap-json" | "markdown" {
  return value === "markdown" ? "markdown" : "tiptap-json";
}

async function receiveMultipartFileToTemp(c: Context): Promise<{ tmpDir: string; tmpPath: string; filename: string; size: number }> {
  const contentType = c.req.header("content-type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new Error("请求必须是 multipart/form-data");
  }

  const contentLength = Number(c.req.header("content-length") || "");
  if (Number.isFinite(contentLength) && contentLength > SIYUAN_IMPORT_MAX_BYTES) {
    throw new SiyuanImportTooLargeError();
  }

  const body = c.req.raw.body;
  if (!body) throw new Error("请求体为空");

  // 进程异常中断时可能残留旧目录；每隔一段时间做一次清理兜底。
  await cleanupStaleSiyuanImportTmpDirs();

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), SIYUAN_IMPORT_TMP_PREFIX));
  const tmpPath = path.join(tmpDir, "upload.zip");

  try {
    return await new Promise((resolve, reject) => {
      const busboy = Busboy({
        headers: { "content-type": contentType },
        limits: { files: 1, fileSize: SIYUAN_IMPORT_MAX_BYTES },
      });
      let seenFile = false;
      let filename = "siyuan.zip";
      let size = 0;
      let fileWrite: Promise<void> | null = null;

      let failed = false;
      const fail = (err: unknown) => {
        if (failed) return;
        failed = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      busboy.on("file", (fieldName: string, file: NodeJS.ReadableStream, info: { filename?: string }) => {
        if (fieldName !== "file" || seenFile) {
          file.resume();
          return;
        }
        seenFile = true;
        filename = info?.filename || filename;
        const out = fs.createWriteStream(tmpPath);
        file.on("data", (chunk: Buffer) => { size += chunk.length; });
        file.on("limit", () => {
          file.unpipe(out);
          out.destroy();
          file.resume();
          fail(new SiyuanImportTooLargeError());
        });
        file.on("error", fail);
        out.on("error", fail);
        file.pipe(out);
        fileWrite = new Promise((res, rej) => {
          out.on("finish", () => res());
          out.on("error", rej);
          file.on("error", rej);
        });
      });

      busboy.on("error", fail);
      busboy.on("finish", () => {
        void (async () => {
          try {
            if (!seenFile) throw new Error("缺少 file 字段");
            if (fileWrite) await fileWrite;
            if (size <= 0) throw new Error("上传文件为空");
            resolve({ tmpDir, tmpPath, filename, size });
          } catch (err) {
            fail(err);
          }
        })();
      });

      Readable.fromWeb(body as any).pipe(busboy);
    });
  } catch (err) {
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
}

// 获取笔记（含完整内容）+ 笔记本信息，用于前端打包导出
//   - 默认按 personal（workspaceId IS NULL）
//   - 传 ?workspaceId=<uuid> 时按指定工作区过滤
app.get("/notes", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const wsRaw = c.req.query("workspaceId") ?? undefined;
  const { sql: wsSql, param: wsParam } = workspaceFilter(wsRaw);

  // 闸门：个人空间导出——按当前用户的 users.personalExportEnabled 判定（方案 B）
  const denied = denyIfPersonalFeatureDisabled(
    userId,
    wsParam === null,
    "personalExportEnabled",
  );
  if (denied) return c.json(denied, 403);

  // 注意：必须同时返回 notebookId。
  //   前端 "按笔记本导出（含子孙）" 依赖 notebookId 过滤；如果只给 notebookName，
  //   同名子笔记本在不同父目录下会混淆，且重命名/移动后无法准确识别归属。
  const stmt = db.prepare(`
    SELECT n.id, n.title, n.content, n.contentText, n.createdAt, n.updatedAt,
           n.notebookId as notebookId,
           nb.name as notebookName,
           n.contentFormat
    FROM notes n
    LEFT JOIN notebooks nb ON n.notebookId = nb.id
    WHERE n.userId = ? AND n.isTrashed = 0
      ${wsSql}
    ORDER BY nb.name, n.title
  `);
  const notes = wsParam === null ? stmt.all(userId) : stmt.all(userId, wsParam);

  return c.json(notes);
});

// 前端保留富文本 -> Markdown 的格式转换，后端负责把结果和附件流式写入临时 ZIP。
// POST 只创建异步任务并立即返回，避免 NAS 反向代理因长时间无响应而超时。
app.post("/markdown-package/jobs", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const wsRaw = c.req.query("workspaceId") ?? undefined;
  const { sql: wsSql, param: wsParam } = workspaceFilter(wsRaw);
  const denied = denyIfPersonalFeatureDisabled(userId, wsParam === null, "personalExportEnabled");
  if (denied) return c.json(denied, 403);

  const body = await c.req.json().catch(() => null) as {
    notes?: PreparedMarkdownNote[];
    inlineImages?: boolean;
    layout?: "notebooks" | "flat";
    filenameBase?: string;
  } | null;
  const notes = body?.notes;
  if (!Array.isArray(notes) || notes.length === 0) {
    return c.json({ error: "没有可导出的笔记", code: "NO_NOTES" }, 400);
  }

  const noteIds = notes.map((note) => note?.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  if (noteIds.length !== notes.length || new Set(noteIds).size !== noteIds.length) {
    return c.json({ error: "导出笔记列表包含无效或重复 ID", code: "INVALID_NOTE_IDS" }, 400);
  }

  const stmt = db.prepare(`
    SELECT n.id
      FROM notes n
     WHERE n.userId = ? AND n.isTrashed = 0
       ${wsSql}
  `);
  const rows = (wsParam === null
    ? stmt.all(userId)
    : stmt.all(userId, wsParam)) as Array<{ id: string }>;
  const allowedIds = new Set(rows.map((row) => row.id));
  if (noteIds.some((id) => !allowedIds.has(id))) {
    return c.json({ error: "部分笔记不存在或不属于当前导出空间", code: "NOTE_SCOPE_MISMATCH" }, 403);
  }

  try {
    const job = createMarkdownExportJob({
      userId,
      notes,
      inlineImages: body?.inlineImages === true,
      layout: body?.layout === "flat" ? "flat" : "notebooks",
      filenameBase: typeof body?.filenameBase === "string" ? body.filenameBase : undefined,
    });
    return c.json({ job }, 202);
  } catch (error) {
    if (error instanceof MarkdownExportBusyError) {
      return c.json({ error: error.message, code: error.code }, 409);
    }
    throw error;
  }
});

app.get("/markdown-package/jobs/:id", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const job = getMarkdownExportJob(c.req.param("id"), userId);
  if (!job) return c.json({ error: "导出任务不存在或已过期", code: "EXPORT_JOB_NOT_FOUND" }, 404);
  return c.json({ job });
});

// PDF / DOCX 依赖浏览器端排版生成，但不能继续用 about:blank Blob 下载，否则
// Chrono 等下载扩展可能在字节收满后无法完成。这里把生成结果流式落到临时文件，
// 再复用真实 HTTP 下载地址。
app.post("/download-jobs", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const encodedFilename = c.req.header("X-Export-Filename") || "export.bin";
  let filename: string;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    return c.json({ error: "导出文件名无效", code: "INVALID_EXPORT_FILENAME" }, 400);
  }
  const contentType = (c.req.header("Content-Type") || "application/octet-stream").split(";")[0].trim();
  const allowedTypes = new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]);
  if (!allowedTypes.has(contentType)) {
    return c.json({ error: "仅支持 PDF 和 DOCX 导出中转", code: "UNSUPPORTED_EXPORT_TYPE" }, 415);
  }
  if (!c.req.raw.body) return c.json({ error: "导出文件为空", code: "EMPTY_EXPORT_FILE" }, 400);

  try {
    const result = await stageGeneratedExport({
      userId,
      filename,
      contentType,
      body: c.req.raw.body,
      contentLength: Number(c.req.header("Content-Length") || "") || undefined,
    });
    return c.json(result, 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : "准备导出文件失败",
      code: "EXPORT_STAGE_FAILED",
    }, 400);
  }
});

// 导入笔记（批量）
//   - 默认按 personal（写入 notes.workspaceId = NULL，notebooks 也按 NULL 域查找/创建）
//   - 传 ?workspaceId=<uuid> 时所有新笔记和新笔记本都落到该工作区
app.post("/import", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const wsRaw = c.req.query("workspaceId") ?? undefined;
  // 工作区参数：personal/空 → null（写库时也是 NULL），否则保持字符串
  const targetWs: string | null =
    !wsRaw || wsRaw.trim() === "" || wsRaw.trim() === "personal" ? null : wsRaw.trim();

  // 闸门：个人空间导入——按当前用户的 users.personalImportEnabled 判定（方案 B）
  const denied = denyIfPersonalFeatureDisabled(
    userId,
    targetWs === null,
    "personalImportEnabled",
  );
  if (denied) return c.json(denied, 403);

  const body = await c.req.json();
  const { notes, notebookId, notebookName } = body as {
    notes: {
      title: string;
      content: string;
      contentText: string;
      createdAt?: string;
      updatedAt?: string;
      contentFormat?: string;
      notebookName?: string; // 可选：按原笔记本名归属（单层，向后兼容）
      notebookPath?: string[]; // 可选：笔记本层级路径（从根到叶），如 ["我是文章2", "test2", "新笔记本"]
    }[];
    notebookId?: string;
    notebookName?: string; // 可选：全局指定导入目标笔记本名
  };

  if (!notes || !Array.isArray(notes) || notes.length === 0) {
    return c.json({ error: "No notes provided" }, 400);
  }

  const { v4: uuid } = require("uuid");

  // 笔记本名 -> id 的缓存（用户 + workspaceId 维度；不同空间不共享）
  const nbCache = new Map<string, string>();

  // 工作区比较：notebooks.workspaceId 也用 NULL 表示个人空间，IS 比较可同时匹配。
  const findNbByName = db.prepare(
    "SELECT id FROM notebooks WHERE userId = ? AND name = ? AND workspaceId IS ? AND isDeleted = 0"
  );
  const insertNbByName = db.prepare(
    "INSERT INTO notebooks (id, userId, name, icon, workspaceId) VALUES (?, ?, ?, ?, ?)"
  );

  const getOrCreateNotebookByName = (name: string, icon = "📥"): string => {
    const key = name.trim() || "导入的笔记";
    const cached = nbCache.get(key);
    if (cached) return cached;
    const existing = findNbByName.get(userId, key, targetWs) as { id: string } | undefined;
    if (existing) {
      nbCache.set(key, existing.id);
      return existing.id;
    }
    const id = uuid();
    insertNbByName.run(id, userId, key, icon, targetWs);
    nbCache.set(key, id);
    return id;
  };

  /**
   * 按层级路径（从根到叶）查找或创建笔记本，返回叶级 id。
   * 匹配规则：`(userId, workspaceId, parentId, name)` 唯一；每级都复用已存在的同名子笔记本。
   * 空/非法路径返回 null，由调用方回退。
   */
  const findChild = db.prepare(
    "SELECT id FROM notebooks WHERE userId = ? AND name = ? AND parentId IS ? AND workspaceId IS ? AND isDeleted = 0"
  );
  const insertNbWithParent = db.prepare(
    "INSERT INTO notebooks (id, userId, parentId, name, icon, workspaceId) VALUES (?, ?, ?, ?, ?, ?)"
  );

  const getOrCreateNotebookByPath = (path: string[], icon = "📥"): string | null => {
    const segs = path
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s) => s.length > 0);
    if (segs.length === 0) return null;

    // 缓存 key：完整路径（用 \u0001 作为分隔符，避免与名字冲突）
    const cacheKey = "__PATH__\u0001" + segs.join("\u0001");
    const cached = nbCache.get(cacheKey);
    if (cached) return cached;

    let parentId: string | null = null;
    let currentId: string | null = null;

    for (const seg of segs) {
      // better-sqlite3：使用 IS 比较可同时匹配 NULL 和非 NULL 的 parentId / workspaceId
      const row = findChild.get(userId, seg, parentId, targetWs) as { id: string } | undefined;
      if (row) {
        currentId = row.id;
      } else {
        const newId = uuid();
        insertNbWithParent.run(newId, userId, parentId, seg, icon, targetWs);
        currentId = newId;
      }
      parentId = currentId;
    }

    if (currentId) nbCache.set(cacheKey, currentId);
    return currentId;
  };

  // 决定"默认笔记本 id"：
  // - 若前端传了 notebookId，则所有笔记都归到该 id（覆盖 note.notebookName）。
  //   必须校验它仍是当前 scope 下的可见笔记本，避免导入到软删除笔记本后
  //   前端提示成功但侧边栏不可见。
  // - 否则若传了全局 notebookName，按该名找/建（限定在 targetWs 域）
  // - 否则每条 note 若带 notebookName 就按各自名找/建，没带的归到"导入的笔记"
  let explicitFallbackId: string | null = null;
  if (notebookId) {
    const targetNotebook = db
      .prepare(
        "SELECT id, userId, workspaceId, isDeleted FROM notebooks WHERE id = ?",
      )
      .get(notebookId) as
      | { id: string; userId: string; workspaceId: string | null; isDeleted: number }
      | undefined;

    if (!targetNotebook) {
      return c.json({ error: "目标笔记本不存在", code: "NOTEBOOK_NOT_FOUND" }, 400);
    }
    if (targetNotebook.isDeleted === 1) {
      return c.json({ error: "目标笔记本已删除，无法导入", code: "NOTEBOOK_TRASHED" }, 400);
    }
    if ((targetNotebook.workspaceId || null) !== targetWs) {
      return c.json({ error: "目标笔记本不属于当前导入空间", code: "NOTEBOOK_SCOPE_MISMATCH" }, 400);
    }
    if (targetWs === null && targetNotebook.userId !== userId) {
      return c.json({ error: "无权导入到该笔记本", code: "NOTEBOOK_FORBIDDEN" }, 403);
    }
    if (targetWs !== null && !isSystemAdmin(userId) && !hasRole(getUserWorkspaceRole(targetWs, userId), "editor")) {
      return c.json({ error: "无权导入到该笔记本", code: "NOTEBOOK_FORBIDDEN" }, 403);
    }
    explicitFallbackId = targetNotebook.id;
  } else if (notebookName && notebookName.trim()) {
    explicitFallbackId = getOrCreateNotebookByName(notebookName.trim());
  }

  // INSERT 时显式带 workspaceId，确保新笔记落到指定工作区。
  const insertWithDates = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, createdAt, updatedAt, workspaceId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDefault = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, workspaceId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // 导入后如果发现 content 里有内联 base64 图片，需要再 UPDATE 一次把 src 换成 URL。
  // 这里必须在 INSERT notes 之后才能写 attachments 行（外键依赖），所以走两步。
  const updateContent = db.prepare(`
    UPDATE notes SET content = ? WHERE id = ?
  `);

  const imported: any[] = [];
  const usedNotebookIds = new Set<string>();

  const tx = db.transaction(() => {
    for (const note of notes) {
      // 决定这条笔记的归属 notebookId
      // 优先级：
      //   1) explicitFallbackId（前端显式指定 notebookId 或全局 notebookName）
      //   2) note.notebookPath（有层级，逐级查找/创建；保留完整目录结构）
      //   3) note.notebookName（兼容单层）
      //   4) "导入的笔记" 兜底
      let targetId: string | null = null;
      if (explicitFallbackId) {
        targetId = explicitFallbackId;
      } else if (Array.isArray(note.notebookPath) && note.notebookPath.length > 0) {
        targetId = getOrCreateNotebookByPath(note.notebookPath);
      }
      if (!targetId) {
        if (note.notebookName && note.notebookName.trim()) {
          targetId = getOrCreateNotebookByName(note.notebookName.trim());
        } else {
          targetId = getOrCreateNotebookByName("导入的笔记");
        }
      }
      usedNotebookIds.add(targetId);

      const id = uuid();
      const contentFormat = normalizeImportedContentFormat(note.contentFormat);
      if (note.createdAt || note.updatedAt) {
        const createdAt = note.createdAt || new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
        const updatedAt = note.updatedAt || createdAt;
        insertWithDates.run(id, userId, targetId, note.title, note.content, note.contentText, contentFormat, createdAt, updatedAt, targetWs);
      } else {
        insertDefault.run(id, userId, targetId, note.title, note.content, note.contentText, contentFormat, targetWs);
      }

      // 抽取 content 里的内联 base64 图片为 attachments：
      //   - 导入 zip 时前端 importService 会把图片编码进 data URI；若直接入库会把
      //     notes.content 撑大到 MB 级，后续 GET 性能崩塌（这是本次改造的根本目的）。
      //   - 短路策略保证"没有内联图"的常规导入完全无额外成本。
      let finalContent: string | null = note.content ?? null;
      if (note.content && note.content.indexOf("data:image") >= 0) {
        // 附件与笔记同 workspace（targetWs 已决定）。
        const { content: rewritten, replacedCount } = extractInlineBase64Images(
          note.content,
          userId,
          id,
          targetWs,
        );
        if (replacedCount > 0) {
          updateContent.run(rewritten, id);
          finalContent = rewritten;
        }
      }

      // v11: 维护 attachment_references 倒排（在事务内）。
      // 仅当最终 content 含 `/api/attachments/` 才走，避免无意义查询。
      if (finalContent && finalContent.indexOf("/api/attachments/") >= 0) {
        try {
          syncAttachmentReferences(db, id, finalContent);
        } catch (e) {
          // 单条失败不阻断整批导入；日志便于事后排查
          console.warn(
            "[export.import] syncAttachmentReferences failed for note",
            id,
            e instanceof Error ? e.message : e,
          );
        }
      }

      // 返回 version 让前端在后续 PUT /notes/:id 时能正确传入（H4 乐观锁强校验
      //   title/content/contentText 必须带 version），避免有道云导入等链路在
      //   "占位笔记 → 上传附件 → 回填正文"第三步因漏 version 被 400。
      //   新建笔记 notes.version DEFAULT 1，这里直接写死 1。
      imported.push({ id, title: note.title, notebookId: targetId, version: 1 });
    }
  });
  tx();

  // 通知当前用户的所有 WebSocket 连接：有新笔记被导入，前端应刷新列表
  broadcastToUser(userId, {
    type: "notes:imported" as any,
    count: imported.length,
    notebookIds: Array.from(usedNotebookIds),
    workspaceId: targetWs,
  });

  return c.json({
    success: true,
    count: imported.length,
    workspaceId: targetWs,
    // 向后兼容：若仅写入一个笔记本，直接返回 id；否则返回首个
    notebookId: explicitFallbackId || imported[0]?.notebookId,
    notebookIds: Array.from(usedNotebookIds),
    notes: imported,
  }, 201);
});

// ====== 思源 .sy 数据包导入（服务端流式路径） ======

app.post("/import/siyuan-package", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const wsRaw = c.req.query("workspaceId") ?? undefined;
  const targetWs: string | null =
    !wsRaw || wsRaw.trim() === "" || wsRaw.trim() === "personal" ? null : wsRaw.trim();
  const targetNotebookId = (c.req.query("targetNotebookId") || "").trim() || undefined;
  const contentFormat = normalizeImportedContentFormat(c.req.query("contentFormat"));

  const denied = denyIfPersonalFeatureDisabled(
    userId,
    targetWs === null,
    "personalImportEnabled",
  );
  if (denied) return c.json(denied, 403);

  if (targetWs !== null && !isSystemAdmin(userId) && !hasRole(getUserWorkspaceRole(targetWs, userId), "editor")) {
    return c.json({ error: "无权导入到该工作区", code: "WORKSPACE_FORBIDDEN" }, 403);
  }

  if (targetNotebookId) {
    const targetNotebook = db
      .prepare("SELECT id, userId, workspaceId, isDeleted FROM notebooks WHERE id = ?")
      .get(targetNotebookId) as
      | { id: string; userId: string; workspaceId: string | null; isDeleted: number }
      | undefined;
    if (!targetNotebook) return c.json({ error: "目标笔记本不存在", code: "NOTEBOOK_NOT_FOUND" }, 400);
    if (targetNotebook.isDeleted === 1) return c.json({ error: "目标笔记本已删除，无法导入", code: "NOTEBOOK_TRASHED" }, 400);
    if ((targetNotebook.workspaceId || null) !== targetWs) {
      return c.json({ error: "目标笔记本不属于当前导入空间", code: "NOTEBOOK_SCOPE_MISMATCH" }, 400);
    }
    if (targetWs === null && targetNotebook.userId !== userId) {
      return c.json({ error: "无权导入到该笔记本", code: "NOTEBOOK_FORBIDDEN" }, 403);
    }
  }

  let uploaded: { tmpDir: string; tmpPath: string; filename: string; size: number } | null = null;
  try {
    uploaded = await receiveMultipartFileToTemp(c);
    const { importSiyuanPackageFromZipFile } = await import("../services/siyuanPackageImport");
    const result = await importSiyuanPackageFromZipFile(uploaded.tmpPath, {
      userId,
      workspaceId: targetWs,
      targetNotebookId,
      contentFormat,
    });

    broadcastToUser(userId, {
      type: "notes:imported" as any,
      count: result.count,
      notebookIds: result.notebookIds,
      workspaceId: targetWs,
    });

    return c.json(result, 201);
  } catch (err: any) {
    if (err instanceof SiyuanImportTooLargeError || err?.code === "SIYUAN_IMPORT_TOO_LARGE") {
      return c.json({ error: err?.message || "思源导入包过大", code: "SIYUAN_IMPORT_TOO_LARGE" }, 413);
    }
    if (err?.code === "SIYUAN_ZIP_BUDGET_EXCEEDED") {
      return c.json({ error: err?.message || "思源导入包解压后超出限制", code: "SIYUAN_ZIP_BUDGET_EXCEEDED" }, 413);
    }
    console.error("[export.import.siyuan-package] Error:", err);
    return c.json({ error: err?.message || "Siyuan import failed", code: "SIYUAN_IMPORT_FAILED" }, 500);
  } finally {
    if (uploaded?.tmpDir) {
      try { await fs.promises.rm(uploaded.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

// ====== Nowen 数据包导出 ======

app.get("/nowen-package", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const wsRaw = c.req.query("workspaceId") ?? undefined;
  const notebookId = c.req.query("notebookId") ?? undefined;
  const includeSubNotebooks = c.req.query("includeSubNotebooks") !== "false";
  const includeTrashed = c.req.query("includeTrashed") === "true";

  // 闸门检查
  const { sql: wsSql, param: wsParam } = workspaceFilter(wsRaw);
  const denied = denyIfPersonalFeatureDisabled(userId, wsParam === null, "personalExportEnabled");
  if (denied) return c.json(denied, 403);

  try {
    const { createStableNowenPackageExport } = await import("../services/nowenPackageExportStable");
    const result = await createStableNowenPackageExport({
      userId,
      workspaceId: wsParam,
      notebookId,
      includeSubNotebooks,
      includeTrashed,
    });

    return new Response(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(result.filename)}"`,
        "X-Export-Notes": String(result.stats.notes),
        "X-Export-Attachments": String(result.stats.attachments),
        "X-Export-Warnings": String(result.stats.warnings),
      },
    });
  } catch (err: any) {
    console.error("[export/nowen-package] Error:", err);
    return c.json({ error: err.message || "Export failed", code: "EXPORT_FAILED" }, 500);
  }
});

// ====== Nowen 数据包导入 ======

app.post("/import/nowen-package", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const dryRun = c.req.query("dryRun") === "1" || c.req.query("dryRun") === "true";
  const importMode = (c.req.query("importMode") as "new-root" | "into-target" | "merge" | "sync") || "new-root";
  const targetNotebookId = c.req.query("targetNotebookId") || undefined;

  // 解析 workspaceId
  const wsRaw = c.req.query("workspaceId") ?? undefined;
  const { sql: wsSql, param: wsParam } = workspaceFilter(wsRaw);

  // 闸门检查
  const isPersonalScope = wsParam === null;
  const denied = denyIfPersonalFeatureDisabled(userId, isPersonalScope, "personalImportEnabled");
  if (denied) return c.json(denied, 403);

  try {
    // 解析 multipart form data
    const body = await c.req.parseBody();
    const file = body["file"];

    if (!file || !(file instanceof File)) {
      return c.json({ error: "No file uploaded", code: "NO_FILE" }, 400);
    }

    // 读取文件内容
    const arrayBuffer = await file.arrayBuffer();
    const zipBuffer = Buffer.from(arrayBuffer);

    // 调用导入服务
    const { importNowenPackage } = await import("../services/nowenPackageImport");
    const result = await importNowenPackage(zipBuffer, {
      userId,
      workspaceId: wsParam,
      targetNotebookId,
      importMode,
      dryRun,
    });

    if (!result.success) {
      return c.json(result, 400);
    }

    // 广播刷新事件
    if (!dryRun && result.success) {
      try {
        broadcastToUser(userId, {
          type: "notes:imported",
          payload: {
            rootNotebookId: result.rootNotebookId,
            counts: result.counts,
          },
        } as any);
        broadcastToUser(userId, { type: "notebooks:changed", payload: {} } as any);
      } catch { }
    }

    return c.json(result, 200);
  } catch (err: any) {
    console.error("[import/nowen-package] Error:", err);
    return c.json({ error: err.message || "Import failed", code: "IMPORT_FAILED" }, 500);
  }
});

export default app;
