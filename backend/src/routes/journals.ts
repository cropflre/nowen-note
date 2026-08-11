/**
 * 今日日记路由
 * ---------------------------------------------------------------------------
 * 提供"一键创建今日日记"功能。
 *
 * 接口：
 *   POST /api/journals/today   获取或创建今日日记（显式操作，避免 GET 副作用）
 *   GET  /api/journals/check   检查今日日记是否存在（只读，不创建）
 *   GET  /api/journals/list    获取日记列表（按日期倒序）
 *
 * 设计决策：
 *   - 使用 note_type = 'journal' 区分日记和普通笔记
 *   - journal_date 使用 YYYY-MM-DD 格式，按用户本地日期
 *   - 唯一性通过 UNIQUE 索引保证（userId + note_type + journal_date）
 *   - 标题默认使用日期格式 "2026-06-26"
 *   - POST 语义：显式创建或获取，避免浏览器预请求/缓存误触发
 */

import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import {
  ensureJournalArchiveFolders,
  ensureJournalArchivePlacement,
  organizeJournalArchive,
  parseJournalDateKey,
} from "../services/journalArchiveTree.js";
import {
  applyJournalArchiveCleanup,
  previewJournalArchiveCleanup,
  restoreJournalArchiveCleanup,
} from "../services/journalArchiveCleanup.js";
import {
  checkWorkspaceJournal,
  getOrCreateWorkspaceJournal,
  WorkspaceJournalError,
} from "../services/workspaceJournals.js";

const app = new Hono();

/**
 * 获取本地日期字符串（YYYY-MM-DD 格式）
 *
 * 重要：不使用 toISOString().slice(0, 10)，因为这会返回 UTC 日期，
 * 在 UTC+8 时区晚上/凌晨会生成前一天的日期。
 *
 * @param dateStr 可选日期字符串，默认使用当前本地时间
 * @returns YYYY-MM-DD 格式的本地日期字符串
 */
function getLocalDateKey(dateStr?: string): string {
  if (dateStr !== undefined) return parseJournalDateKey(dateStr).dateKey;

  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 获取或创建今日日记（POST 语义）
 *
 * 为什么用 POST 而非 GET：
 *   - GET 可能被浏览器预请求、缓存、爬虫、代理误触发
 *   - POST 语义明确表示"创建或获取"，是幂等的写操作
 *   - 避免用户意外触发日记创建
 *
 * 并发安全：
 *   - UNIQUE 索引 (userId, note_type, journal_date) 防止重复创建
 *   - INSERT 冲突时回退查询已有日记
 *
 * body 参数：
 *   - localDate: YYYY-MM-DD（可选，前端传入用户本地日期）
 */
app.post("/today", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";

  if (!userId) {
    return c.json({ error: "未授权" }, 401);
  }

  // 解析 body（可选）
  let localDate: string | undefined;
  try {
    const body = await c.req.json().catch(() => ({}));
    localDate = body?.localDate;
  } catch {
    // body 解析失败不阻塞，使用服务端日期
  }

  let today: string;
  try {
    today = getLocalDateKey(localDate);
  } catch {
    return c.json({ error: "日期格式无效，请使用 YYYY-MM-DD" }, 400);
  }

  // 查询是否已有今日日记
  const existing = db.prepare(`
    SELECT id, userId, notebookId, workspaceId, title, content, contentText,
           isPinned, isLocked, isArchived, isTrashed, version, sortOrder,
           createdAt, updatedAt, trashedAt, contentFormat, note_type, journal_date
    FROM notes
    WHERE userId = ? AND note_type = 'journal' AND journal_date = ?
      AND isTrashed = 0
  `).get(userId, today) as any;

  if (existing) {
    const archive = ensureJournalArchivePlacement({
      db,
      userId,
      noteId: existing.id,
      dateKey: today,
    });
    const refreshed = db.prepare(`
      SELECT id, userId, notebookId, workspaceId, title, content, contentText,
             isPinned, isLocked, isArchived, isTrashed, version, sortOrder,
             createdAt, updatedAt, trashedAt, contentFormat, note_type, journal_date
      FROM notes
      WHERE id = ?
    `).get(existing.id);
    return c.json({
      ...refreshed as any,
      existed: true,
      archive,
    });
  }

  // 不存在，创建新日记。目录与日记在同一事务内落地：
  // 个人日记 / YYYY年 / YYYY年MM月 / YYYY-MM-DD。
  const id = uuid();
  const title = today;

  try {
    const result = db.transaction(() => {
      const folders = ensureJournalArchiveFolders({ db, userId, dateKey: today });
      db.prepare(`
        INSERT INTO notes (
          id, userId, notebookId, title, content, contentText,
          note_type, journal_date, sortOrder
        ) VALUES (?, ?, ?, ?, '{}', '', 'journal', ?, 0)
      `).run(id, userId, folders.monthNotebookId, title, today);

      const archive = ensureJournalArchivePlacement({
        db,
        userId,
        noteId: id,
        dateKey: today,
      });
      const created = db.prepare(`
        SELECT id, userId, notebookId, workspaceId, title, content, contentText,
               isPinned, isLocked, isArchived, isTrashed, version, sortOrder,
               createdAt, updatedAt, trashedAt, contentFormat, note_type, journal_date
        FROM notes
        WHERE id = ?
      `).get(id);
      return { created, archive };
    })();

    return c.json({
      ...result.created as any,
      existed: false,
      archive: result.archive,
    }, 201);
  } catch (err: any) {
    // UNIQUE 约束冲突：并发创建时回退查询已有日记并修复目录归属。
    if (String(err?.code || "").startsWith("SQLITE_CONSTRAINT")) {
      const retry = db.prepare(`
        SELECT id, userId, notebookId, workspaceId, title, content, contentText,
               isPinned, isLocked, isArchived, isTrashed, version, sortOrder,
               createdAt, updatedAt, trashedAt, contentFormat, note_type, journal_date
        FROM notes
        WHERE userId = ? AND note_type = 'journal' AND journal_date = ?
          AND isTrashed = 0
      `).get(userId, today) as any;
      if (!retry?.id) throw err;
      const archive = ensureJournalArchivePlacement({
        db,
        userId,
        noteId: retry.id,
        dateKey: today,
      });
      const refreshedRetry = db.prepare(`
        SELECT id, userId, notebookId, workspaceId, title, content, contentText,
               isPinned, isLocked, isArchived, isTrashed, version, sortOrder,
               createdAt, updatedAt, trashedAt, contentFormat, note_type, journal_date
        FROM notes
        WHERE id = ?
      `).get(retry.id);
      return c.json({
        ...refreshedRetry as any,
        existed: true,
        archive,
      });
    }
    throw err;
  }
});

/**
 * 检查今日日记是否存在（只读，不创建）
 *
 * query 参数：
 *   - date: YYYY-MM-DD（可选，默认今天）
 */
app.get("/check", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";

  if (!userId) {
    return c.json({ error: "未授权" }, 401);
  }

  const dateParam = c.req.query("date");
  let today: string;
  try {
    today = getLocalDateKey(dateParam);
  } catch {
    return c.json({ error: "日期格式无效，请使用 YYYY-MM-DD" }, 400);
  }

  const existing = db.prepare(`
    SELECT id, title
    FROM notes
    WHERE userId = ? AND note_type = 'journal' AND journal_date = ?
      AND isTrashed = 0
  `).get(userId, today) as { id: string; title: string } | undefined;

  return c.json({
    exists: !!existing,
    noteId: existing?.id || null,
    title: existing?.title || null,
  });
});

function workspaceJournalErrorResponse(c: any, error: unknown) {
  if (error instanceof WorkspaceJournalError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("INVALID_JOURNAL_DATE:")) {
    return c.json({ error: "日期格式无效，请使用 YYYY-MM-DD", code: "INVALID_JOURNAL_DATE" }, 400);
  }
  throw error;
}

/** 检查当前成员能否访问指定工作区的某日日记；只读，不创建。 */
app.get("/workspace/:workspaceId/check", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  const workspaceId = c.req.param("workspaceId");
  let dateKey: string;
  try {
    dateKey = getLocalDateKey(c.req.query("date"));
    const result = checkWorkspaceJournal({
      db, workspaceId, actorUserId: userId, dateKey,
    });
    return c.json({
      ...result,
      scope: "workspace",
      workspaceId,
    });
  } catch (error) {
    return workspaceJournalErrorResponse(c, error);
  }
});

/** 获取或创建工作区共享日记。只读成员可打开已有日记，但不能创建缺失日期。 */
app.post("/workspace/:workspaceId/resolve", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  const workspaceId = c.req.param("workspaceId");
  const body = await c.req.json().catch(() => ({}));
  try {
    const dateKey = getLocalDateKey(body?.localDate);
    const result = getOrCreateWorkspaceJournal({
      db, workspaceId, actorUserId: userId, dateKey,
    });
    return c.json({
      ...result.note,
      existed: result.existed,
      canWrite: result.canWrite,
      role: result.role,
      archive: result.archive,
      scope: "workspace",
    }, result.existed ? 200 : 201);
  } catch (error) {
    return workspaceJournalErrorResponse(c, error);
  }
});

/**
 * 将已有日记整理为真实的知识树实体目录。
 *
 * 显式 POST，重复执行安全；不会修改日记正文和标题，也不会删除旧空笔记本。
 */
app.post("/organize", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);

  const result = organizeJournalArchive({ db, userId });
  return c.json({ success: true, ...result });
});

/**
 * 预览迁移后可安全清理的旧空笔记本。
 *
 * 只有具备 journal_archive 移动历史、仍为空、没有子目录、共享、密码或 ACL 的
 * 个人笔记本才会进入候选列表。GET 只读，不产生删除副作用。
 */
app.get("/cleanup-preview", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  return c.json(previewJournalArchiveCleanup({ db, userId }));
});

/**
 * 按最新预览执行安全清理。
 *
 * previewToken 用于防止预览后目录又新增内容时仍按旧状态删除。清理只软删除空笔记本，
 * 不移动或删除任何笔记，并返回 cleanupId 供撤销。
 */
app.post("/cleanup", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const previewToken = typeof body?.previewToken === "string" ? body.previewToken.trim() : "";
  const candidateIds = Array.isArray(body?.candidateIds)
    ? body.candidateIds.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
    : undefined;
  if (!/^[0-9a-f]{64}$/i.test(previewToken)) {
    return c.json({ error: "预览令牌无效" }, 400);
  }
  if (candidateIds && candidateIds.length > 100) {
    return c.json({ error: "单次最多清理 100 个目录" }, 400);
  }

  try {
    const result = applyJournalArchiveCleanup({ db, userId, previewToken, candidateIds });
    return c.json({ success: true, ...result });
  } catch (error: any) {
    const message = String(error?.message || "");
    if (message === "JOURNAL_ARCHIVE_CLEANUP_STALE_PREVIEW") {
      return c.json({ error: "目录状态已经变化，请重新预览", code: message }, 409);
    }
    if (message === "JOURNAL_ARCHIVE_CLEANUP_INVALID_SELECTION") {
      return c.json({ error: "清理范围包含不安全目录", code: message }, 400);
    }
    throw error;
  }
});

/** 撤销一次日记旧目录清理。 */
app.post("/cleanup/restore", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const cleanupId = typeof body?.cleanupId === "string" ? body.cleanupId.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(cleanupId)) {
    return c.json({ error: "清理记录无效" }, 400);
  }
  try {
    const result = restoreJournalArchiveCleanup({ db, userId, cleanupId });
    return c.json({ success: true, ...result });
  } catch (error: any) {
    const message = String(error?.message || "");
    if (message === "JOURNAL_ARCHIVE_CLEANUP_NOT_FOUND") {
      return c.json({ error: "找不到可撤销的清理记录", code: message }, 404);
    }
    if (message.startsWith("JOURNAL_ARCHIVE_CLEANUP_PARENT_UNAVAILABLE")) {
      return c.json({ error: "原父目录不可用，无法安全撤销", code: message }, 409);
    }
    throw error;
  }
});

/**
 * 获取日记列表（按日期倒序）
 */
app.get("/list", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const limit = Math.min(parseInt(c.req.query("limit") || "30"), 100);
  const cursor = c.req.query("cursor"); // 上次最后一条的 journal_date

  if (!userId) {
    return c.json({ error: "未授权" }, 401);
  }

  let query = `
    SELECT id, userId, notebookId, workspaceId, title, content, contentText,
           isPinned, isLocked, isArchived, isTrashed, version, sortOrder,
           createdAt, updatedAt, trashedAt, contentFormat, note_type, journal_date
    FROM notes
    WHERE userId = ? AND note_type = 'journal' AND isTrashed = 0
  `;
  const params: any[] = [userId];

  if (cursor) {
    query += " AND journal_date < ?";
    params.push(cursor);
  }

  query += " ORDER BY journal_date DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(query).all(...params) as any[];
  const hasMore = rows.length === limit;
  const nextCursor = rows.length > 0 ? rows[rows.length - 1].journal_date : null;

  return c.json({
    items: rows,
    hasMore,
    nextCursor,
  });
});

/**
 * 获取日记年月归档结构
 *
 * 返回按年月分组的日记树，用于侧边栏展示。
 * 分组基于 journal_date，不使用 createdAt 或 title。
 */
app.get("/archive", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";

  if (!userId) {
    return c.json({ error: "未授权" }, 401);
  }

  // 查询所有日记，按 journal_date 倒序
  const rows = db.prepare(`
    SELECT id, title, journal_date, createdAt, updatedAt
    FROM notes
    WHERE userId = ?
      AND note_type = 'journal'
      AND journal_date IS NOT NULL
      AND journal_date != ''
      AND isTrashed = 0
    ORDER BY journal_date DESC
  `).all(userId) as { id: string; title: string; journal_date: string; createdAt: string; updatedAt: string }[];

  // 按年月分组
  const yearMap = new Map<string, {
    count: number;
    months: Map<string, {
      count: number;
      journals: Array<{
        id: string;
        title: string;
        journalDate: string;
        createdAt: string;
        updatedAt: string;
      }>;
    }>;
  }>();

  for (const row of rows) {
    const dateStr = row.journal_date; // YYYY-MM-DD
    const year = dateStr.slice(0, 4);  // YYYY
    const month = dateStr.slice(5, 7); // MM

    if (!yearMap.has(year)) {
      yearMap.set(year, { count: 0, months: new Map() });
    }
    const yearEntry = yearMap.get(year)!;
    yearEntry.count++;

    if (!yearEntry.months.has(month)) {
      yearEntry.months.set(month, { count: 0, journals: [] });
    }
    const monthEntry = yearEntry.months.get(month)!;
    monthEntry.count++;
    monthEntry.journals.push({
      id: row.id,
      title: row.title,
      journalDate: row.journal_date,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  // 转换为前端需要的结构（年份倒序，月份倒序）
  const years = Array.from(yearMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, yearData]) => ({
      year,
      count: yearData.count,
      months: Array.from(yearData.months.entries())
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([month, monthData]) => ({
          month,
          count: monthData.count,
          journals: monthData.journals, // 已按 journal_date 倒序
        })),
    }));

  return c.json({ years });
});

export default app;
