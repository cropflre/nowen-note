import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema.js";
import { getUserWorkspaceRole, hasRole, isSystemAdmin, resolveNotePermission } from "../middleware/acl.js";

export interface WorkspaceIssue {
  id: string;
  workspaceId: string;
  number: number;
  title: string;
  content: string;
  status: "open" | "closed";
  createdBy: string | null;
  closedBy: string | null;
  closedAt: string | null;
  relatedNoteId: string | null;
  createdAt: string;
  updatedAt: string;
}

export class IssueError extends Error {
  constructor(message: string, public status: 400 | 401 | 403 | 404) { super(message); }
}

export function workspaceIssueAccess(workspaceId: string, userId: string) {
  if (!userId) throw new IssueError("请先登录", 401);
  const db = getDb();
  if (!db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId)) {
    throw new IssueError("工作区不存在", 404);
  }
  const role = isSystemAdmin(userId) ? "owner" : getUserWorkspaceRole(workspaceId, userId);
  if (!role) throw new IssueError("无权访问该工作区", 403);
  return { role, canComment: hasRole(role, "commenter"), canManage: hasRole(role, "editor"), canAdmin: hasRole(role, "admin") };
}

export function requireIssue(issueId: string, userId: string) {
  const issue = getDb().prepare("SELECT * FROM workspace_issues WHERE id = ?").get(issueId) as WorkspaceIssue | undefined;
  if (!issue) throw new IssueError("议题不存在", 404);
  const access = workspaceIssueAccess(issue.workspaceId, userId);
  return { issue, access };
}

export function issueForRead(issue: WorkspaceIssue, userId: string) {
  const db = getDb();
  const author = db.prepare("SELECT COALESCE(NULLIF(displayName, ''), username) AS name FROM users WHERE id = ?").get(issue.createdBy) as { name: string } | undefined;
  const count = db.prepare("SELECT COUNT(*) AS total FROM workspace_issue_comments WHERE issueId = ?").get(issue.id) as { total: number };
  // 关联笔记可能有更严格的目录权限；议题成员身份不能绕过笔记 ACL。
  const canReadNote = issue.relatedNoteId && resolveNotePermission(issue.relatedNoteId, userId).permission;
  const note = canReadNote ? db.prepare("SELECT id, title FROM notes WHERE id = ? AND isTrashed = 0").get(issue.relatedNoteId) as { id: string; title: string } | undefined : undefined;
  return { ...issue, relatedNoteId: note?.id ?? null, relatedNote: note ?? null, authorName: author?.name ?? null, commentCount: count.total };
}

export function validateRelatedNote(noteId: unknown, workspaceId: string, userId: string): string | null {
  if (noteId === null || noteId === undefined || noteId === "") return null;
  if (typeof noteId !== "string") throw new IssueError("关联笔记格式无效", 400);
  const note = getDb().prepare("SELECT workspaceId FROM notes WHERE id = ? AND isTrashed = 0").get(noteId) as { workspaceId: string | null } | undefined;
  if (!note || note.workspaceId !== workspaceId || !resolveNotePermission(noteId, userId).permission) {
    throw new IssueError("无法关联该笔记，请选择当前工作区内可访问的笔记", 403);
  }
  return noteId;
}

export function textField(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) {
    throw new IssueError(`${label}不能为空且不能超过 ${max} 字符`, 400);
  }
  return value.trim();
}

export function notifyIssue(issue: WorkspaceIssue, actorId: string, type: string, body: string, now: string) {
  const db = getDb();
  const members = db.prepare(`SELECT m.userId FROM workspace_members m JOIN users u ON u.id = m.userId
    WHERE m.workspaceId = ? AND m.userId <> ? AND u.isDisabled = 0`).all(issue.workspaceId, actorId) as { userId: string }[];
  const insert = db.prepare(`INSERT INTO notifications
    (id, userId, workspaceId, type, actorUserId, resourceType, resourceId, title, body, createdAt)
    VALUES (?, ?, ?, ?, ?, 'workspace_issue', ?, ?, ?, ?)`);
  for (const member of members) {
    insert.run(uuid(), member.userId, issue.workspaceId, type, actorId, issue.id, issue.title, body.slice(0, 200), now);
  }
}

// 每次读取重新检查成员身份和资源存在性，移除成员后不会泄露历史通知。
export const VISIBLE_NOTIFICATIONS = `FROM notifications n
  JOIN workspace_members m ON m.workspaceId = n.workspaceId AND m.userId = n.userId
  JOIN workspace_issues i ON i.id = n.resourceId AND i.workspaceId = n.workspaceId
  WHERE n.userId = ? AND n.resourceType = 'workspace_issue'`;
