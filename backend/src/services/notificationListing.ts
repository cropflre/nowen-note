import { getDb } from "../db/schema.js";
import { resolveEffectiveNoteCapabilities } from "./share-capabilities.js";
import { canViewNoteThroughFolderPasswords } from "../lib/knowledgeTreePasswordAccess.js";
import { VISIBLE_NOTIFICATIONS } from "./workspaceIssues.js";

type NotificationRow = {
  id: string; userId: string; workspaceId: string | null; type: string; resourceType: string; resourceId: string;
  title: string; body: string; readAt: string | null; createdAt: string; actorName: string | null; workspaceName: string | null;
  noteId?: string; commentId?: string;
};

export function visibleNotifications(userId: string, unlockedFolderNodeIds = new Set<string>()): NotificationRow[] {
  const db = getDb();
  const issues = db.prepare(`SELECT n.*, (SELECT COALESCE(NULLIF(u.displayName, ''), u.username) FROM users u WHERE u.id = n.actorUserId) AS actorName,
    (SELECT w.name FROM workspaces w WHERE w.id = n.workspaceId) AS workspaceName ${VISIBLE_NOTIFICATIONS}`).all(userId) as NotificationRow[];
  const comments = db.prepare(`SELECT n.*, sc.noteId, sc.id AS commentId, note.workspaceId,
    note.title AS title, sc.content AS body,
    COALESCE(NULLIF(sc.guestName, ''), NULLIF(u.displayName, ''), u.username, '匿名') AS actorName,
    (SELECT w.name FROM workspaces w WHERE w.id = note.workspaceId) AS workspaceName
    FROM notifications n JOIN share_comments sc ON sc.id = n.resourceId JOIN notes note ON note.id = sc.noteId
    LEFT JOIN users u ON u.id = n.actorUserId
    WHERE n.userId = ? AND n.resourceType = 'note_comment' AND note.isTrashed = 0`).all(userId) as NotificationRow[];
  const access = new Map<string, boolean>();
  const readable = comments.filter((item) => {
    const noteId = item.noteId!;
    if (!access.has(noteId)) access.set(noteId, resolveEffectiveNoteCapabilities(noteId, userId).read && canViewNoteThroughFolderPasswords(db, noteId, unlockedFolderNodeIds));
    return access.get(noteId);
  });
  return [...issues, ...readable].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
