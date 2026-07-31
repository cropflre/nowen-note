import crypto from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema.js";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs.js";
import { extractSearchableText } from "../lib/searchIndex.js";
import { hasPermission, resolveNotebookPermission } from "../middleware/acl.js";
import { extractInlineBase64Images } from "../routes/attachments.js";
import miCloudRouter from "../routes/micloud.js";
import {
  synchronizeLegacyNoteHierarchy,
  synchronizeLegacyNotebookHierarchy,
} from "../services/legacyKnowledgeHierarchy.js";

const ROUTE_PATCH_FLAG = Symbol.for("nowen.micloudImportHardening.routePatch");
const ROUTER_INSTALLED_FLAG = Symbol.for("nowen.micloudImportHardening.routerInstalled");
const LEGACY_ERROR_HANDLER_FLAG = Symbol.for("nowen.micloudImportHardening.legacyErrorHandler");
const globals = globalThis as typeof globalThis & Record<symbol, boolean>;

const SOURCE_TYPE = "xiaomi-note";
const DEFAULT_NOTEBOOK_NAME = "小米云笔记";
const MAX_IMPORT_NOTE_IDS = 50;

type LegacyImportPayload = {
  success?: boolean;
  count?: number;
  notebookId?: string;
  notes?: Array<{ id?: string; title?: string }>;
  errors?: string[];
  error?: string;
  code?: string;
};

type NotebookScope = {
  notebookId: string;
  workspaceId: string | null;
  workspaceScope: string;
};

function ensureImportOriginSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS note_import_origins (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      workspaceScope TEXT NOT NULL,
      noteId TEXT NOT NULL,
      sourceType TEXT NOT NULL,
      externalId TEXT NOT NULL,
      contentHash TEXT,
      batchId TEXT,
      importedAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT,
      metadata TEXT,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_note_import_origins_scope_external
      ON note_import_origins(userId, workspaceScope, sourceType, externalId);
    CREATE INDEX IF NOT EXISTS idx_note_import_origins_note
      ON note_import_origins(noteId);
  `);
}

function normalizeNoteIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  )).slice(0, MAX_IMPORT_NOTE_IDS);
}

function safeErrorText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  return text.replace(/\s+/g, " ").slice(0, 500);
}

function errorCode(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim().slice(0, 100) : fallback;
}

async function readLegacyPayload(response: Response): Promise<{ payload: LegacyImportPayload; raw: string }> {
  const raw = await response.text();
  if (!raw.trim()) return { payload: {}, raw: "" };
  try {
    return { payload: JSON.parse(raw) as LegacyImportPayload, raw };
  } catch {
    return { payload: {}, raw };
  }
}

function resolveNotebookScope(notebookId: string, userId: string): NotebookScope | null {
  const db = getDb();
  const notebook = db.prepare(`
    SELECT id, workspaceId, isDeleted
    FROM notebooks
    WHERE id = ?
  `).get(notebookId) as { id: string; workspaceId: string | null; isDeleted: number } | undefined;
  if (!notebook || notebook.isDeleted === 1) return null;

  // 旧数据可能存在业务笔记本行但缺少统一内容树节点。先做一次幂等修复，
  // 否则 notes 的知识树 INSERT 守卫会在写入时统一抛 500。
  synchronizeLegacyNotebookHierarchy({
    db,
    notebookId,
    actorUserId: userId,
    reason: "metadata",
    parentMode: "resource",
  });

  const { permission } = resolveNotebookPermission(notebookId, userId);
  if (!hasPermission(permission, "write")) return null;

  return {
    notebookId,
    workspaceId: notebook.workspaceId || null,
    workspaceScope: notebook.workspaceId || "personal",
  };
}

function ensureDefaultPersonalNotebook(userId: string): NotebookScope {
  const db = getDb();
  const notebookId = db.transaction(() => {
    // 必须限定个人空间且排除软删除记录。旧实现只按 userId + name 查询，
    // 可能误选同名工作区笔记本或回收站里的笔记本，随后 notes.workspaceId=NULL
    // 与父节点 scope 不一致，知识树守卫会让每一条导入都报 500。
    let existing = db.prepare(`
      SELECT id
      FROM notebooks
      WHERE userId = ?
        AND workspaceId IS NULL
        AND isDeleted = 0
        AND name = ?
      ORDER BY createdAt ASC, id ASC
      LIMIT 1
    `).get(userId, DEFAULT_NOTEBOOK_NAME) as { id: string } | undefined;

    if (!existing) {
      existing = { id: crypto.randomUUID() };
      db.prepare(`
        INSERT INTO notebooks (id, userId, workspaceId, name, icon)
        VALUES (?, ?, NULL, ?, '📱')
      `).run(existing.id, userId, DEFAULT_NOTEBOOK_NAME);
    }

    synchronizeLegacyNotebookHierarchy({
      db,
      notebookId: existing.id,
      actorUserId: userId,
      reason: "metadata",
      parentMode: "resource",
    });
    return existing.id;
  })();

  return {
    notebookId,
    workspaceId: null,
    workspaceScope: "personal",
  };
}

function findImportedOrigin(userId: string, scope: NotebookScope, externalId: string) {
  return getDb().prepare(`
    SELECT o.noteId, n.title, n.notebookId
    FROM note_import_origins o
    JOIN notes n ON n.id = o.noteId
    WHERE o.userId = ?
      AND o.workspaceScope = ?
      AND o.sourceType = ?
      AND o.externalId = ?
    LIMIT 1
  `).get(userId, scope.workspaceScope, SOURCE_TYPE, externalId) as
    | { noteId: string; title: string; notebookId: string }
    | undefined;
}

function recordImportedOrigin(
  userId: string,
  scope: NotebookScope,
  externalId: string,
  noteId: string,
  title: string,
): void {
  getDb().prepare(`
    INSERT INTO note_import_origins (
      id, userId, workspaceId, workspaceScope, noteId,
      sourceType, externalId, importedAt, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(userId, workspaceScope, sourceType, externalId) DO UPDATE SET
      noteId = excluded.noteId,
      workspaceId = excluded.workspaceId,
      importedAt = datetime('now'),
      metadata = excluded.metadata
  `).run(
    crypto.randomUUID(),
    userId,
    scope.workspaceId,
    scope.workspaceScope,
    noteId,
    SOURCE_TYPE,
    externalId,
    JSON.stringify({ title }),
  );
}

function hardenImportedNote(noteId: string, userId: string, scope: NotebookScope): string[] {
  const db = getDb();
  const warnings: string[] = [];
  const row = db.prepare(`
    SELECT content, title
    FROM notes
    WHERE id = ? AND userId = ?
  `).get(noteId, userId) as { content: string | null; title: string } | undefined;
  if (!row) return ["导入结果已返回，但数据库中未找到对应笔记"];

  let content = typeof row.content === "string" ? row.content : "<p></p>";

  // 小米图片原先以内联 base64 落库。沿用普通笔记创建流程，把图片迁移为附件，
  // 避免数百条导入把 SQLite 主表和 FTS 事务瞬间放大。
  if (content.includes("data:image")) {
    try {
      const extracted = extractInlineBase64Images(content, userId, noteId, scope.workspaceId);
      if (extracted.replacedCount > 0) content = extracted.content;
    } catch (error) {
      warnings.push(`图片附件化失败：${safeErrorText(error instanceof Error ? error.message : error, "未知错误")}`);
    }
  }

  const contentText = extractSearchableText(content, "html");
  db.prepare(`
    UPDATE notes
    SET content = ?, contentText = ?, contentFormat = 'html', workspaceId = ?
    WHERE id = ? AND userId = ?
  `).run(content, contentText, scope.workspaceId, noteId, userId);

  if (content.includes("/api/attachments/")) {
    try {
      syncAttachmentReferences(db, noteId, content);
    } catch (error) {
      warnings.push(`附件引用索引失败：${safeErrorText(error instanceof Error ? error.message : error, "未知错误")}`);
    }
  }

  try {
    synchronizeLegacyNoteHierarchy({
      db,
      noteId,
      actorUserId: userId,
      reason: "create",
      parentMode: "resource",
    });
  } catch (error) {
    warnings.push(`目录索引同步失败：${safeErrorText(error instanceof Error ? error.message : error, "未知错误")}`);
  }

  return warnings;
}

async function invokeLegacySingleImport(
  cookie: string,
  externalId: string,
  notebookId: string,
  userId: string,
): Promise<{ response: Response; payload: LegacyImportPayload; raw: string }> {
  const response = await miCloudRouter.request("/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userId,
      "Accept": "application/json",
    },
    body: JSON.stringify({ cookie, noteIds: [externalId], notebookId }),
  });
  const parsed = await readLegacyPayload(response);
  return { response, ...parsed };
}

async function hardenedMiCloudImport(c: Context) {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权", code: "UNAUTHENTICATED" }, 401);

  const body = await c.req.json().catch(() => null) as
    | { cookie?: unknown; noteIds?: unknown; notebookId?: unknown }
    | null;
  const cookie = typeof body?.cookie === "string" ? body.cookie.trim() : "";
  const noteIds = normalizeNoteIds(body?.noteIds);
  const requestedNotebookId = typeof body?.notebookId === "string" && body.notebookId.trim()
    ? body.notebookId.trim()
    : undefined;

  if (!cookie) return c.json({ error: "缺少 Cookie", code: "COOKIE_REQUIRED" }, 400);
  if (noteIds.length === 0) {
    return c.json({ error: "请选择要导入的笔记", code: "NOTES_REQUIRED" }, 400);
  }

  ensureImportOriginSchema();
  let scope: NotebookScope;
  try {
    const resolved = requestedNotebookId
      ? resolveNotebookScope(requestedNotebookId, userId)
      : ensureDefaultPersonalNotebook(userId);
    if (!resolved) {
      return c.json({ error: "目标笔记本不存在、已删除或无写入权限", code: "NOTEBOOK_FORBIDDEN" }, 403);
    }
    scope = resolved;
  } catch (error) {
    const code = errorCode(error, "MICLOUD_NOTEBOOK_PREPARE_FAILED");
    const detail = safeErrorText(error instanceof Error ? error.message : error, "目标笔记本初始化失败");
    console.error("[micloud/import] prepare notebook failed", { userId, code, detail });
    return c.json({ error: `目标笔记本初始化失败：${detail}`, code }, 500);
  }

  const imported: Array<{ id: string; title: string }> = [];
  const errors: string[] = [];
  let skippedCount = 0;
  let targetNotebookId = scope.notebookId;

  // 旧实现把一个批次的所有 DB INSERT 放在同一事务中：任意一条旧笔记含异常字符、
  // FTS 写入失败或附件过大，整个批次都会回滚并冒泡为纯文本 500。
  // 这里按单条调用旧转换器，把故障隔离到具体笔记，其余笔记继续导入。
  for (const externalId of noteIds) {
    const existing = findImportedOrigin(userId, scope, externalId);
    if (existing) {
      skippedCount += 1;
      imported.push({ id: existing.noteId, title: existing.title });
      continue;
    }

    try {
      const { response, payload, raw } = await invokeLegacySingleImport(
        cookie,
        externalId,
        targetNotebookId,
        userId,
      );

      if (!response.ok || payload.success === false || !payload.notes?.[0]?.id) {
        const detail = safeErrorText(
          payload.error || raw,
          `HTTP ${response.status}`,
        );
        const suffix = payload.code ? ` [${payload.code}]` : "";
        errors.push(`笔记 ${externalId} 导入失败：${detail}${suffix}`);
        continue;
      }

      const resolvedScope = resolveNotebookScope(targetNotebookId, userId);
      if (!resolvedScope) {
        errors.push(`笔记 ${externalId} 已写入，但无法确认目标笔记本权限`);
        continue;
      }
      scope = resolvedScope;

      const note = payload.notes[0];
      const noteId = String(note.id);
      const title = typeof note.title === "string" && note.title.trim()
        ? note.title.trim()
        : "未命名笔记";
      const warnings = hardenImportedNote(noteId, userId, scope);
      recordImportedOrigin(userId, scope, externalId, noteId, title);
      imported.push({ id: noteId, title });

      if (Array.isArray(payload.errors)) {
        errors.push(...payload.errors.map((message) => `笔记 ${externalId}：${safeErrorText(message, "处理失败")}`));
      }
      errors.push(...warnings.map((message) => `笔记 ${externalId}：${message}`));
    } catch (error) {
      errors.push(
        `笔记 ${externalId} 导入异常：${safeErrorText(error instanceof Error ? error.message : error, "未知错误")}`,
      );
    }
  }

  const acceptedCount = imported.length;
  if (acceptedCount === 0) {
    const firstError = errors[0] || "没有成功导入任何小米笔记";
    return c.json({
      success: false,
      count: 0,
      createdCount: 0,
      skippedCount,
      notebookId: targetNotebookId,
      notes: [],
      errors,
      error: firstError,
      code: "MICLOUD_IMPORT_FAILED",
    }, 500);
  }

  return c.json({
    success: true,
    // 兼容现有前端：count 表示本批已成功处理数量，包含幂等跳过项。
    count: acceptedCount,
    createdCount: acceptedCount - skippedCount,
    skippedCount,
    notebookId: targetNotebookId,
    notes: imported,
    errors,
  }, 201);
}

function installLegacyErrorHandler(): void {
  if (globals[LEGACY_ERROR_HANDLER_FLAG]) return;
  globals[LEGACY_ERROR_HANDLER_FLAG] = true;
  miCloudRouter.onError((error, c) => {
    const code = errorCode(error, "MICLOUD_LEGACY_IMPORT_FAILED");
    const detail = safeErrorText(error instanceof Error ? error.message : error, "小米笔记写入失败");
    console.error("[micloud/import] legacy route failed", { code, detail });
    return c.json({ success: false, error: detail, code }, 500);
  });
}

export function installMiCloudImportHardening(root: Hono<any>): void {
  const taggedRoot = root as Hono<any> & Record<symbol, boolean>;
  if (taggedRoot[ROUTER_INSTALLED_FLAG]) return;
  taggedRoot[ROUTER_INSTALLED_FLAG] = true;
  root.post("/api/micloud/import", hardenedMiCloudImport);
}

installLegacyErrorHandler();

if (!globals[ROUTE_PATCH_FLAG]) {
  globals[ROUTE_PATCH_FLAG] = true;
  const prototype = Hono.prototype as any;
  const nativeRoute = prototype.route as (this: Hono<any>, path: string, subApp: Hono<any>) => Hono<any>;
  prototype.route = function patchedRoute(this: Hono<any>, path: string, subApp: Hono<any>) {
    if (path === "/api/micloud") installMiCloudImportHardening(this);
    return nativeRoute.call(this, path, subApp);
  };
}
