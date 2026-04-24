import { Hono } from "hono";
import { getDb } from "../db/schema";
import { extractInlineBase64Images } from "./attachments";
import { broadcastToUser } from "../services/realtime";

const app = new Hono();

// 获取所有笔记（含完整内容）+ 笔记本信息，用于前端打包导出
app.get("/notes", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  // 注意：必须同时返回 notebookId。
  //   前端 "按笔记本导出（含子孙）" 依赖 notebookId 过滤；如果只给 notebookName，
  //   同名子笔记本在不同父目录下会混淆，且重命名/移动后无法准确识别归属。
  const notes = db.prepare(`
    SELECT n.id, n.title, n.content, n.contentText, n.createdAt, n.updatedAt,
           n.notebookId as notebookId,
           nb.name as notebookName
    FROM notes n
    LEFT JOIN notebooks nb ON n.notebookId = nb.id
    WHERE n.userId = ? AND n.isTrashed = 0
    ORDER BY nb.name, n.title
  `).all(userId);

  return c.json(notes);
});

// 导入笔记（批量）
app.post("/import", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
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

  const { v4: uuid } = require("uuid");

  // 笔记本名 -> id 的缓存（用户维度）
  const nbCache = new Map<string, string>();

  const getOrCreateNotebookByName = (name: string, icon = "📥"): string => {
    const key = name.trim() || "导入的笔记";
    const cached = nbCache.get(key);
    if (cached) return cached;
    const existing = db.prepare(
      "SELECT id FROM notebooks WHERE userId = ? AND name = ?"
    ).get(userId, key) as { id: string } | undefined;
    if (existing) {
      nbCache.set(key, existing.id);
      return existing.id;
    }
    const id = uuid();
    db.prepare(
      "INSERT INTO notebooks (id, userId, name, icon) VALUES (?, ?, ?, ?)"
    ).run(id, userId, key, icon);
    nbCache.set(key, id);
    return id;
  };

  /**
   * 按层级路径（从根到叶）查找或创建笔记本，返回叶级 id。
   * 匹配规则：`(userId, parentId, name)` 唯一；每级都复用已存在的同名子笔记本。
   * 空/非法路径返回 null，由调用方回退。
   */
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

    const findChild = db.prepare(
      "SELECT id FROM notebooks WHERE userId = ? AND name = ? AND parentId IS ?"
    );
    const insertNb = db.prepare(
      "INSERT INTO notebooks (id, userId, parentId, name, icon) VALUES (?, ?, ?, ?, ?)"
    );

    for (const seg of segs) {
      // better-sqlite3：使用 IS 比较可同时匹配 NULL 和非 NULL 的 parentId
      const row = findChild.get(userId, seg, parentId) as { id: string } | undefined;
      if (row) {
        currentId = row.id;
      } else {
        const newId = uuid();
        insertNb.run(newId, userId, parentId, seg, icon);
        currentId = newId;
      }
      parentId = currentId;
    }

    if (currentId) nbCache.set(cacheKey, currentId);
    return currentId;
  };

  // 决定"默认笔记本 id"：
  // - 若前端传了 notebookId，则所有笔记都归到该 id（覆盖 note.notebookName）
  // - 否则若传了全局 notebookName，按该名找/建
  // - 否则每条 note 若带 notebookName 就按各自名找/建，没带的归到"导入的笔记"
  const explicitFallbackId =
    notebookId ||
    (notebookName && notebookName.trim() ? getOrCreateNotebookByName(notebookName.trim()) : null);

  const insertWithDates = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDefault = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText)
    VALUES (?, ?, ?, ?, ?, ?)
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
        insertWithDates.run(id, userId, targetId, note.title, note.content, note.contentText, createdAt, updatedAt);
      } else {
        insertDefault.run(id, userId, targetId, note.title, note.content, note.contentText);
      }

      // 抽取 content 里的内联 base64 图片为 attachments：
      //   - 导入 zip 时前端 importService 会把图片编码进 data URI；若直接入库会把
      //     notes.content 撑大到 MB 级，后续 GET 性能崩塌（这是本次改造的根本目的）。
      //   - 短路策略保证"没有内联图"的常规导入完全无额外成本。
      if (note.content && note.content.indexOf("data:image") >= 0) {
        const { content: rewritten, replacedCount } = extractInlineBase64Images(
          note.content,
          userId,
          id,
        );
        if (replacedCount > 0) {
          updateContent.run(rewritten, id);
        }
      }

      imported.push({ id, title: note.title, notebookId: targetId });
    }
  });
  tx();

  // 通知当前用户的所有 WebSocket 连接：有新笔记被导入，前端应刷新列表
  broadcastToUser(userId, {
    type: "notes:imported" as any,
    count: imported.length,
    notebookIds: Array.from(usedNotebookIds),
  });

  return c.json({
    success: true,
    count: imported.length,
    // 向后兼容：若仅写入一个笔记本，直接返回 id；否则返回首个
    notebookId: explicitFallbackId || imported[0]?.notebookId,
    notebookIds: Array.from(usedNotebookIds),
    notes: imported,
  }, 201);
});

export default app;
