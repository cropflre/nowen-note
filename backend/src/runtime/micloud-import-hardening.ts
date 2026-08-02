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

export type MiCloudImportScope = {
  notebookId: string;
  workspaceId: string | null;
  workspaceScope: string;
};

export type MiCloudImportRowResult = {
  success: boolean;
  note?: { id: string; title: string };
  errors: string[];
  error?: string;
};

export type MiCloudImportPayload = {
  success: boolean;
  count: number;
  createdCount: number;
  skippedCount: number;
  notebookId?: string;
  notes: Array<{ id: string; title: string }>;
  errors: string[];
  error?: string;
  code?: string;
};

export type MiCloudImportRunResult = {
  status: number;
  payload: MiCloudImportPayload;
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
  // 小米云返回多少行就处理多少行：只过滤无效空值，保留原始顺序与重复 ID。
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_IMPORT_NOTE_IDS);
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

function resolveNotebookScope(notebookId: string, userId: string): MiCloudImportScope | null {
  const db = getDb();
  const notebook = db.prepare(`
    SELECT id, workspaceId, isDeleted
    FROM notebooks
    WHERE id = ?
  `).get(notebookId) as { id: string; workspaceId: string | null; isDeleted: number } | undefined;
  if (!notebook || notebook.isDeleted === 1) return null;

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

function ensureDefaultPersonalNotebook(userId: string): MiCloudImportScope {
  const db = getDb();
  const notebookId = db.transaction(() => {
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

export function prepareMiCloudImportTarget(
  userId: string,
  requestedNotebookId?: string,
): MiCloudImportScope | null {
  ensureImportOriginSchema();
  return requestedNotebookId
    ? resolveNotebookScope(requestedNotebookId, userId)
    : ensureDefaultPersonalNotebook(userId);
}

function recordImportedOrigin(
  userId: string,
  scope: MiCloudImportScope,
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

function hardenImportedNote(noteId: string, userId: string, scope: MiCloudImportScope): string[] {
  const db = getDb();
  const warnings: string[] = [];
  const row = db.prepare(`
    SELECT content, title
    FROM notes
    WHERE id = ? AND userId = ?
  `).get(noteId, userId) as { content: string | null; title: string } | undefined;
  if (!row) return ["导入结果已返回，但数据库中未找到对应笔记"];

  let content = typeof row.content === "string" ? row.content : "<p></p>";
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

export async function importMiCloudRow(input: {
  cookie: string;
  externalId: string;
  userId: string;
  scope: MiCloudImportScope;
}): Promise<MiCloudImportRowResult> {
  const { cookie, externalId, userId, scope } = input;
  const errors: string[] = [];

  try {
    const { response, payload, raw } = await invokeLegacySingleImport(
      cookie,
      externalId,
      scope.notebookId,
      userId,
    );

    if (!response.ok || payload.success === false || !payload.notes?.[0]?.id) {
      const detail = safeErrorText(payload.error || raw, `HTTP ${response.status}`);
      const suffix = payload.code ? ` [${payload.code}]` : "";
      const error = `笔记 ${externalId} 导入失败：${detail}${suffix}`;
      return { success: false, errors: [error], error };
    }

    const note = payload.notes[0];
    const noteId = String(note.id);
    const title = typeof note.title === "string" && note.title.trim()
      ? note.title.trim()
      : "未命名笔记";
    const warnings = hardenImportedNote(noteId, userId, scope);
    recordImportedOrigin(userId, scope, externalId, noteId, title);

    if (Array.isArray(payload.errors)) {
      errors.push(...payload.errors.map((message) => `笔记 ${externalId}：${safeErrorText(message, "处理失败")}`));
    }
    errors.push(...warnings.map((message) => `笔记 ${externalId}：${message}`));

    return {
      success: true,
      note: { id: noteId, title },
      errors,
    };
  } catch (error) {
    const detail = safeErrorText(error instanceof Error ? error.message : error, "未知错误");
    const message = `笔记 ${externalId} 导入异常：${detail}`;
    return { success: false, errors: [message], error: message };
  }
}

export async function runMiCloudImportRows(input: {
  cookie: string;
  noteIds: unknown;
  notebookId?: string;
  userId: string;
}): Promise<MiCloudImportRunResult> {
  const cookie = typeof input.cookie === "string" ? input.cookie.trim() : "";
  const noteIds = normalizeNoteIds(input.noteIds);
  const requestedNotebookId = typeof input.notebookId === "string" && input.notebookId.trim()
    ? input.notebookId.trim()
    : undefined;

  const basePayload = {
    count: 0,
    createdCount: 0,
    skippedCount: 0,
    notes: [] as Array<{ id: string; title: string }>,
  };

  if (!input.userId) {
    return { status: 401, payload: { success: false, ...basePayload, errors: ["未授权"], error: "未授权", code: "UNAUTHENTICATED" } };
  }
  if (!cookie) {
    return { status: 400, payload: { success: false, ...basePayload, errors: ["缺少 Cookie"], error: "缺少 Cookie", code: "COOKIE_REQUIRED" } };
  }
  if (noteIds.length === 0) {
    return { status: 400, payload: { success: false, ...basePayload, errors: ["请选择要导入的笔记"], error: "请选择要导入的笔记", code: "NOTES_REQUIRED" } };
  }

  let scope: MiCloudImportScope;
  try {
    const resolved = prepareMiCloudImportTarget(input.userId, requestedNotebookId);
    if (!resolved) {
      return {
        status: 403,
        payload: {
          success: false,
          ...basePayload,
          errors: ["目标笔记本不存在、已删除或无写入权限"],
          error: "目标笔记本不存在、已删除或无写入权限",
          code: "NOTEBOOK_FORBIDDEN",
        },
      };
    }
    scope = resolved;
  } catch (error) {
    const code = errorCode(error, "MICLOUD_NOTEBOOK_PREPARE_FAILED");
    const detail = safeErrorText(error instanceof Error ? error.message : error, "目标笔记本初始化失败");
    console.error("[micloud/import] prepare notebook failed", { userId: input.userId, code, detail });
    return {
      status: 500,
      payload: {
        success: false,
        ...basePayload,
        errors: [`目标笔记本初始化失败：${detail}`],
        error: `目标笔记本初始化失败：${detail}`,
        code,
      },
    };
  }

  const imported: Array<{ id: string; title: string }> = [];
  const errors: string[] = [];
  for (const externalId of noteIds) {
    const result = await importMiCloudRow({ cookie, externalId, userId: input.userId, scope });
    if (result.success && result.note) imported.push(result.note);
    errors.push(...result.errors);
  }

  const acceptedCount = imported.length;
  if (acceptedCount === 0) {
    const firstError = errors[0] || "没有成功导入任何小米笔记";
    return {
      status: 500,
      payload: {
        success: false,
        count: 0,
        createdCount: 0,
        skippedCount: 0,
        notebookId: scope.notebookId,
        notes: [],
        errors,
        error: firstError,
        code: "MICLOUD_IMPORT_FAILED",
      },
    };
  }

  return {
    status: 201,
    payload: {
      success: true,
      count: acceptedCount,
      createdCount: acceptedCount,
      skippedCount: 0,
      notebookId: scope.notebookId,
      notes: imported,
      errors,
    },
  };
}

async function hardenedMiCloudImport(c: Context) {
  const body = await c.req.json().catch(() => null) as
    | { cookie?: unknown; noteIds?: unknown; notebookId?: unknown }
    | null;
  const result = await runMiCloudImportRows({
    cookie: typeof body?.cookie === "string" ? body.cookie : "",
    noteIds: body?.noteIds,
    notebookId: typeof body?.notebookId === "string" ? body.notebookId : undefined,
    userId: c.req.header("X-User-Id") || "",
  });
  return c.json(result.payload, result.status as any);
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
