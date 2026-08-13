import crypto from "node:crypto";
import type Database from "better-sqlite3";
import jwt from "jsonwebtoken";

import { JWT_SECRET } from "./auth-security.js";

const FOLDER_UNLOCK_SECRET = crypto
  .createHmac("sha256", JWT_SECRET)
  .update("nowen-folder-unlock-v1")
  .digest("hex");

interface FolderUnlockTokenPayload {
  typ: "folder-unlock";
  userId: string;
  nodeId: string;
  notebookId: string;
  passwordVersion: number;
  iat?: number;
  exp?: number;
}

function verifiedFolderUnlockTokenPayload(token: string): FolderUnlockTokenPayload | null {
  try {
    const payload = jwt.verify(token, FOLDER_UNLOCK_SECRET) as FolderUnlockTokenPayload;
    return payload.typ === "folder-unlock" ? payload : null;
  } catch {
    return null;
  }
}

export function signFolderUnlockToken(input: {
  userId: string;
  nodeId: string;
  notebookId: string;
  passwordVersion: number;
}): string {
  return jwt.sign({ typ: "folder-unlock", ...input }, FOLDER_UNLOCK_SECRET, { expiresIn: "12h" });
}

export function verifyFolderUnlockToken(
  token: string,
  expected: {
    userId: string;
    nodeId: string;
    notebookId: string;
    passwordVersion: number;
  },
): boolean {
  const payload = verifiedFolderUnlockTokenPayload(token);
  return payload !== null
    && payload.userId === expected.userId
    && payload.nodeId === expected.nodeId
    && payload.notebookId === expected.notebookId
    && payload.passwordVersion === expected.passwordVersion;
}

export function parseFolderUnlockTokens(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 100);
}

/**
 * 将请求携带的解锁令牌收敛为当前仍有效的目录节点集合。
 * 密码版本或目录绑定关系发生变化后，旧令牌会在这里立即失效。
 */
export function resolveUnlockedFolderNodeIds(
  db: Database.Database,
  userId: string,
  headerValue: string | undefined,
): Set<string> {
  const unlocked = new Set<string>();
  for (const token of parseFolderUnlockTokens(headerValue)) {
    const payload = verifiedFolderUnlockTokenPayload(token);
    if (!payload || payload.userId !== userId) continue;
    const current = db.prepare(`
      SELECT password.passwordVersion
        FROM knowledge_tree_nodes node
        JOIN notebook_passwords password
          ON password.notebookId = node.resourceId
       WHERE node.id = ?
         AND node.resourceType = 'notebook'
         AND node.resourceId = ?
         AND node.isDeleted = 0
       LIMIT 1
    `).get(payload.nodeId, payload.notebookId) as { passwordVersion: number } | undefined;
    if (current?.passwordVersion === payload.passwordVersion) unlocked.add(payload.nodeId);
  }
  return unlocked;
}

/**
 * 笔记只有在其每一级加密祖先目录都已解锁时才可见。
 * 没有统一知识树节点的旧数据继续按原权限规则处理，避免升级后误隐藏历史笔记。
 */
export function canViewNoteThroughFolderPasswords(
  db: Database.Database,
  noteId: string,
  unlockedFolderNodeIds: Set<string>,
  options: { includeDeleted?: boolean } = {},
): boolean {
  const protectedAncestors = db.prepare(`
    WITH RECURSIVE ancestors(id, parentId, resourceType, resourceId) AS (
      SELECT id, parentId, resourceType, resourceId
        FROM knowledge_tree_nodes
       WHERE resourceType = 'note'
         AND resourceId = ?
         AND (? = 1 OR isDeleted = 0)
      UNION
      SELECT parent.id, parent.parentId, parent.resourceType, parent.resourceId
        FROM knowledge_tree_nodes parent
        JOIN ancestors child ON child.parentId = parent.id
    )
    SELECT DISTINCT ancestors.id AS nodeId
      FROM ancestors
      JOIN notebook_passwords password
        ON ancestors.resourceType = 'notebook'
       AND password.notebookId = ancestors.resourceId
  `).all(noteId, options.includeDeleted ? 1 : 0) as Array<{ nodeId: string }>;

  return protectedAncestors.every((folder) => unlockedFolderNodeIds.has(folder.nodeId));
}
