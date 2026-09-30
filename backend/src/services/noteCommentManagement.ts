import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema.js";
import { shareCommentsRepository } from "../repositories/shareCommentsRepository.js";
import { resolveEffectiveNoteCapabilities } from "./share-capabilities.js";
import { canViewNoteThroughFolderPasswords } from "../lib/knowledgeTreePasswordAccess.js";
import { IssueError } from "./workspaceIssues.js";

export function listManagedNoteComments(userId: string, options: { status: string; query: string; limit: number; offset: number; unlockedFolderNodeIds?: Set<string> }) {
  if (!["all", "unresolved", "resolved"].includes(options.status)) throw new IssueError("评论状态无效", 400);
  if (options.query.length > 200) throw new IssueError("搜索内容过长", 400);
  const db = getDb();
  // 先按笔记检查统一 Knowledge ACL，避免仅凭 ownerId 或工作区角色绕过受限目录。
  const notes = db.prepare(`SELECT DISTINCT n.id FROM notes n JOIN share_comments sc ON sc.noteId = n.id WHERE n.isTrashed = 0`).all() as { id: string }[];
  const ids = notes.filter((note) => resolveEffectiveNoteCapabilities(note.id, userId).manage && canViewNoteThroughFolderPasswords(db, note.id, options.unlockedFolderNodeIds ?? new Set())).map((note) => note.id);
  if (!ids.length) return { items: [], total: 0 };
  const where = `sc.noteId IN (SELECT value FROM json_each(?))
    ${options.status === "all" ? "" : "AND sc.isResolved = ?"}
    AND (instr(lower(sc.content), lower(?)) > 0 OR instr(lower(n.title), lower(?)) > 0)`;
  const params = [JSON.stringify(ids), ...(options.status === "all" ? [] : [options.status === "resolved" ? 1 : 0]), options.query, options.query];
  const from = `FROM share_comments sc JOIN notes n ON n.id = sc.noteId LEFT JOIN users u ON u.id = sc.userId`;
  const items = db.prepare(`SELECT sc.id, sc.noteId, sc.userId, sc.parentId, sc.content, sc.anchorData, sc.isResolved, sc.createdAt, sc.updatedAt,
    n.title AS noteTitle, n.workspaceId, u.avatarUrl, u.username,
    COALESCE(NULLIF(sc.guestName, ''), NULLIF(u.displayName, ''), u.username, '匿名') AS displayName,
    CASE WHEN sc.userId IS NULL THEN 1 ELSE 0 END AS isGuest
    ${from} WHERE ${where} ORDER BY sc.createdAt DESC, sc.id DESC LIMIT ? OFFSET ?`).all(...params, options.limit, options.offset);
  const total = (db.prepare(`SELECT COUNT(*) AS total ${from} WHERE ${where}`).get(...params) as { total: number }).total;
  return { items, total };
}

export function createNoteCommentWithNotifications(input: Parameters<typeof shareCommentsRepository.create>[0]): void {
  const db = getDb();
  db.transaction(() => {
    shareCommentsRepository.create(input);
    const note = db.prepare("SELECT userId, workspaceId, title, isTrashed FROM notes WHERE id = ?").get(input.noteId) as { userId: string; workspaceId: string | null; title: string; isTrashed: number };
    if (note.isTrashed) return;
    const parent = input.parentId ? shareCommentsRepository.getById(input.parentId) : undefined;
    const recipients = new Set([note.userId, parent?.userId].filter((id): id is string => Boolean(id) && id !== input.userId));
    const insert = db.prepare(`INSERT INTO notifications (id, userId, workspaceId, type, actorUserId, resourceType, resourceId, title, body, createdAt)
      VALUES (?, ?, ?, ?, ?, 'note_comment', ?, ?, ?, ?)`);
    for (const userId of recipients) {
      const user = db.prepare("SELECT isDisabled FROM users WHERE id = ?").get(userId) as { isDisabled: number } | undefined;
      if (!user || user.isDisabled || !resolveEffectiveNoteCapabilities(input.noteId, userId).read) continue;
      insert.run(uuid(), userId, note.workspaceId, userId === parent?.userId ? "note_comment_replied" : "note_commented", input.userId, input.id, note.title, input.content.slice(0, 200), new Date().toISOString());
    }
  }).immediate();
}
