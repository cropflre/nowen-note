/**
 * @提及用户工具函数
 * ---------------------------------------------------------------------------
 * 从文本中提取 @用户名，查找匹配用户，创建 mention 通知记录。
 * 在 diary/notes/tasks 的 create/update 路由中调用。
 */

import { getDb } from "../db/schema";
import crypto from "crypto";

interface MentionResult {
  created: number;
  mentioned: string[];
}

/**
 * 从文本中提取 @用户名列表（去重）
 * 匹配格式：@username（字母、数字、下划线、中文字符、连字符）
 */
export function parseMentionedUsernames(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/@([\w一-鿿-]+)/g);
  if (!matches) return [];
  const usernames = matches.map((m) => m.slice(1));
  return [...new Set(usernames)];
}

/**
 * 解析 mentions 并写入数据库
 *
 * @param sourceType  - "note" | "diary" | "task"
 * @param sourceId    - 源内容 ID
 * @param sourceTitle - 源内容标题（用于消息列表展示）
 * @param contentText - 文本内容（从中解析 @用户名）
 * @param mentionedByUserId - 谁 @的
 * @returns 创建的 mentions 数量和被提及的用户名列表
 */
export function createMentions(
  sourceType: "note" | "diary" | "task",
  sourceId: string,
  sourceTitle: string | null,
  contentText: string,
  mentionedByUserId: string,
): MentionResult {
  const db = getDb();
  const usernames = parseMentionedUsernames(contentText);
  if (usernames.length === 0) return { created: 0, mentioned: [] };

  const created: string[] = [];

  for (const username of usernames) {
    const target = db
      .prepare("SELECT id, displayName FROM users WHERE username = ? AND isDisabled = 0")
      .get(username) as { id: string; displayName: string | null } | undefined;

    if (!target) continue;
    if (target.id === mentionedByUserId) continue;
    const existing = db
      .prepare("SELECT id FROM mentions WHERE sourceType = ? AND sourceId = ? AND mentionedUserId = ?")
      .get(sourceType, sourceId, target.id);
    if (existing) continue;

    const id = crypto.randomUUID();
    // 写入 mentions（兼容旧代码）
    db.prepare(
      `INSERT INTO mentions (id, sourceType, sourceId, sourceTitle, mentionedUserId, mentionedByUserId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(id, sourceType, sourceId, sourceTitle || null, target.id, mentionedByUserId);
    // 写入通用 notifications
    db.prepare(
      `INSERT INTO notifications (id, userId, type, sourceType, sourceId, sourceTitle, actorId, createdAt)
       VALUES (?, ?, 'mention', ?, ?, ?, ?, datetime('now'))`,
    ).run(id, target.id, sourceType, sourceId, sourceTitle || null, mentionedByUserId);

    try {
      const { broadcastToUser } = require("../services/realtime");
      const unread = db.prepare("SELECT COUNT(*) as count FROM mentions WHERE mentionedUserId = ? AND readAt IS NULL").get(target.id) as { count: number };
      broadcastToUser(target.id, {
        type: "notification:received",
        unreadCount: unread.count,
      });
    } catch (e) {
      console.warn("[mentions] failed to broadcast mention notification:", e);
    }

    created.push(username);
  }

  return { created: created.length, mentioned: created };
}

/**
 * 向工作区成员广播通知
 *
 * @param workspaceId - 目标工作区 ID（null = 个人空间，不广播）
 * @param type        - 通知类型
 * @param sourceType  - 来源类型
 * @param sourceId    - 来源 ID
 * @param sourceTitle - 来源标题
 * @param actorId     - 触发者用户 ID
 * @param excludeUserId - 排除的用户 ID（不给自己发）
 */
export function broadcastToWorkspace(
  workspaceId: string | null,
  type: "task_completed" | "diary_posted" | "note_updated",
  sourceType: "note" | "diary" | "task",
  sourceId: string,
  sourceTitle: string | null,
  actorId: string,
  excludeUserId: string,
): number {
  if (!workspaceId) return 0;

  const db = getDb();
  // 获取工作区所有成员
  const members = db
    .prepare("SELECT userId FROM workspace_members WHERE workspaceId = ? AND userId != ?")
    .all(workspaceId, excludeUserId) as { userId: string }[];

  if (members.length === 0) return 0;

  // 获取触发者名字
  const actor = db
    .prepare("SELECT displayName, username FROM users WHERE id = ?")
    .get(actorId) as { displayName: string | null; username: string } | undefined;
  const actorName = actor?.displayName || actor?.username || "某人";

  const stmt = db.prepare(
    `INSERT INTO notifications (id, userId, type, sourceType, sourceId, sourceTitle, actorId, actorName, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );

  let count = 0;
  for (const member of members) {
    // 不重复通知（同一 source 已通知同一用户）
    const existing = db
      .prepare("SELECT id FROM notifications WHERE type = ? AND sourceId = ? AND userId = ?")
      .get(type, sourceId, member.userId);
    if (existing) continue;

    stmt.run(crypto.randomUUID(), member.userId, type, sourceType, sourceId, sourceTitle || null, actorId, actorName);
    count++;
  }

  if (count > 0) {
    try {
      const { broadcastToUser } = require("../services/realtime");
      for (const member of members) {
        const unread = db.prepare("SELECT COUNT(*) as count FROM mentions WHERE mentionedUserId = ? AND readAt IS NULL").get(member.userId) as { count: number };
        broadcastToUser(member.userId, {
          type: "notification:received",
          unreadCount: unread.count,
        });
      }
    } catch (e) {
      console.warn("[mentions] failed to broadcast workspace notifications:", e);
    }
  }

  return count;
}
