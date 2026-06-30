import { Hono } from "hono";
import { getDb } from "../db/schema";
import { extractInlineBase64Images } from "./attachments";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import { broadcastToUser } from "../services/realtime";
import { isSystemAdmin } from "../middleware/acl";
import {
  normalizeImportWorkspaceId,
  requireWorkspaceWriteAccess,
  resolveWritableNotebookTarget,
} from "../lib/import-target-permissions";

const app = new Hono();

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

// 导入笔记（批量）
//   - 默认按 personal（写入 notes.workspaceId = NULL，notebooks 也按 NULL 域查找/创建）
//   - 传 ?workspaceId=<uuid> 时所有新笔记和新笔记本都落到该工作区
app.post("/import", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const wsRaw = c.req.query("workspaceId") ?? undefined;
  const wsWasExplicit = wsRaw !== undefined && wsRaw.trim() !== "";
  // 工作区参数：personal/空 → null（写库时也是 NULL），否则保持字符串。
  // 显式 notebookId 会在解析后以笔记本所属 workspace 为准。
  let targetWs: string | null = normalizeImportWorkspaceId(wsRaw);

  const body = await c.req.json();
  const { notes, notebookId, notebookName } = body as {
    notes: {
      title: string;
      content: string;
      contentText: string;
      createdAt?: string;
      updatedAt?: string;
      notebookName?: string; // 可选：按原笔记本名归属（单层，向后兼容）
      notebookPath?: string[]; // 可选：笔记本层级路径（从根到叶），如 ["我是文章2", "test2", "新笔记本"]
    }[];
    notebookId?: string;
    notebookName?: string; // 可选：全局指定导入目标笔记本名
  };

  if (!notes || !Array.isArray(notes) || notes.length === 0) {
    return c.json({ error: "No notes provided" }, 400);
  }

  let explicitNotebookId: string | null = null;
  if (notebookId) {
    const target = resolveWritableNotebookTarget(
      userId,
      notebookId,
      wsWasExplicit ? targetWs : undefined,
    );
    if (!target.ok) return c.json(target.body, target.status as any);
    explicitNotebookId = target.notebookId;
    targetWs = target.workspaceId;
  } else {
    const deniedWorkspace = requireWorkspaceWriteAccess(userId, targetWs);
    if (deniedWorkspace) {
      return c.json(deniedWorkspace.body, deniedWorkspace.status as any);
    }
  }

  // 闸门：个人空间导入——按解析后的最终 target scope 判定。
  const denied = denyIfPersonalFeatureDisabled(
    userId,
    targetWs === null,
    "personalImportEnabled",
  );
  if (denied) return c.json(denied, 403);

  const { v4: uuid } = require("uuid");

  // 笔记本名 -> id 的缓存（用户 + workspaceId 维度；不同空间不共享）
  const nbCache = new Map<string, string>();

  // 工作区比较：notebooks.workspaceId 也用 NULL 表示个人空间，IS 比较可同时匹配。
  const findNbByName = db.prepare(
    "SELECT id FROM notebooks WHERE userId = ? AND name = ? AND workspaceId IS ?"
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
    "SELECT id FROM notebooks WHERE userId = ? AND name = ? AND parentId IS ? AND workspaceId IS ?"
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
  // - 若前端传了 notebookId，则所有笔记都归到该 id（覆盖 note.notebookName）
  //   后端会校验该 notebook 可写，并从 notebook 继承 workspaceId。
  // - 否则若传了全局 notebookName，按该名找/建（限定在 targetWs 域）
  // - 否则每条 note 若带 notebookName 就按各自名找/建，没带的归到"导入的笔记"
  const explicitFallbackId =
    explicitNotebookId ||
    (notebookName && notebookName.trim() ? getOrCreateNotebookByName(notebookName.trim()) : null);

  // INSERT 时显式带 workspaceId，确保新笔记落到指定工作区。
  const insertWithDates = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, createdAt, updatedAt, workspaceId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDefault = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, workspaceId)
    VALUES (?, ?, ?, ?, ?, ?, ?)
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
      if (note.createdAt || note.updatedAt) {
        const createdAt = note.createdAt || new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
        const updatedAt = note.updatedAt || createdAt;
        insertWithDates.run(id, userId, targetId, note.title, note.content, note.contentText, createdAt, updatedAt, targetWs);
      } else {
        insertDefault.run(id, userId, targetId, note.title, note.content, note.contentText, targetWs);
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
    const { createNowenPackageExport } = await import("../services/nowenPackageExport");
    const result = await createNowenPackageExport({
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
  const importMode = (c.req.query("importMode") as "new-root" | "into-target") || "new-root";
  const targetNotebookId = c.req.query("targetNotebookId") || undefined;

  // 解析 workspaceId
  const wsRaw = c.req.query("workspaceId") ?? undefined;
  const wsWasExplicit = wsRaw !== undefined && wsRaw.trim() !== "";
  const { sql: wsSql, param: wsParam } = workspaceFilter(wsRaw);

  // 闸门检查
  const isPersonalScope = wsParam === null;
  const denied = denyIfPersonalFeatureDisabled(userId, isPersonalScope, "personalImportEnabled");
  if (denied) return c.json(denied, 403);
  if (!(importMode === "into-target" && targetNotebookId)) {
    const deniedWorkspace = requireWorkspaceWriteAccess(userId, wsParam);
    if (deniedWorkspace) {
      return c.json(deniedWorkspace.body, deniedWorkspace.status as any);
    }
  }

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
      workspaceId: wsWasExplicit ? wsParam : undefined,
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
      } catch {}
    }

    return c.json(result, 200);
  } catch (err: any) {
    console.error("[import/nowen-package] Error:", err);
    return c.json({ error: err.message || "Import failed", code: "IMPORT_FAILED" }, 500);
  }
});

export default app;
