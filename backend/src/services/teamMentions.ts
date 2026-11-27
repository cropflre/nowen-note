import type Database from "better-sqlite3";
import { resolveEffectiveNoteCapabilities } from "./share-capabilities.js";

/**
 * 从正文中提取 @username 提及列表（去重，保留小写归一名用于查询）。
 * 规则：@ 前必须是开头、空白或常见中文/英文标点，避免误匹配邮箱地址（如 user@example.com）。
 */
export function extractMentionedUsernames(text: string): string[] {
  if (!text || !text.includes("@")) return [];
  const pattern = /(?:^|[\s([{\u3000，。！？、；：（）【】「」])@([A-Za-z0-9_.\-\u4e00-\u9fa5]{1,40})/g;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1].replace(/[.,!?;:]+$/, "").trim();
    if (raw) seen.add(raw.toLowerCase());
  }
  return Array.from(seen);
}

/**
 * 将 @提及 用户名列表解析为当前工作区内未停用的成员 userId 集合。
 */
export function resolveMentionedWorkspaceUserIds(
  db: Database.Database,
  workspaceId: string,
  text: string,
  excludeUserId?: string | null,
): Set<string> {
  const names = extractMentionedUsernames(text);
  if (names.length === 0) return new Set();

  const placeholders = names.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT m.userId
       FROM workspace_members m
       JOIN users u ON u.id = m.userId
       WHERE m.workspaceId = ?
         AND u.isDisabled = 0
         AND (LOWER(u.username) IN (${placeholders}) OR LOWER(COALESCE(u.displayName, '')) IN (${placeholders}))`,
    )
    .all(workspaceId, ...names, ...names) as Array<{ userId: string }>;

  const result = new Set<string>();
  for (const row of rows) {
    if (excludeUserId && row.userId === excludeUserId) continue;
    result.add(row.userId);
  }
  return result;
}

/**
 * 解析笔记评论中的 @提及 收件人：仅返回存在、未停用且实际具备该笔记读权限的用户。
 */
export function resolveMentionedNoteReaders(
  db: Database.Database,
  noteId: string,
  workspaceId: string | null,
  text: string,
  excludeUserId?: string | null,
): Set<string> {
  const names = extractMentionedUsernames(text);
  if (names.length === 0) return new Set();

  const candidates = workspaceId
    ? resolveMentionedWorkspaceUserIds(db, workspaceId, text, excludeUserId)
    : (() => {
        const placeholders = names.map(() => "?").join(",");
        const rows = db
          .prepare(
            `SELECT id AS userId
             FROM users
             WHERE isDisabled = 0
               AND (LOWER(username) IN (${placeholders}) OR LOWER(COALESCE(displayName, '')) IN (${placeholders}))`,
          )
          .all(...names, ...names) as Array<{ userId: string }>;
        return new Set(rows.map((r) => r.userId).filter((uid) => uid !== excludeUserId));
      })();

  const allowed = new Set<string>();
  for (const uid of candidates) {
    if (resolveEffectiveNoteCapabilities(noteId, uid).read) {
      allowed.add(uid);
    }
  }
  return allowed;
}
