import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

const SESSION_KEY = "nowen-knowledge-tree-folder-unlock-tokens";
export const KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT = "nowen:knowledge-tree-password-session-changed";
export const KNOWLEDGE_TREE_PASSWORD_LOCKED_EVENT = "nowen:knowledge-tree-password-locked";
export const KNOWLEDGE_TREE_PASSWORD_LOCK_BROADCAST_KEY = "nowen:knowledge-tree-password-lock-broadcast";

export type KnowledgeTreeFolderLockReason =
  | "idle"
  | "background"
  | "expired"
  | "manual"
  | "account-changed"
  | "remote";

export interface FolderUnlockSessionSnapshot {
  folderIds: Set<string>;
  earliestExpiresAt: number | null;
}

function emitSessionChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT));
  }
}

function emitLocked(reason: KnowledgeTreeFolderLockReason, folderIds: string[]): void {
  if (typeof window === "undefined" || folderIds.length === 0) return;
  window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_PASSWORD_LOCKED_EVENT, {
    detail: { reason, folderIds },
  }));
}

function tokenPayload(token: string): { userId?: string; exp?: number } | null {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return null;
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    return JSON.parse(atob(padded)) as { userId?: string; exp?: number };
  } catch {
    return null;
  }
}

function readRawFolderUnlockTokenMap(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => (
        typeof entry[0] === "string" && typeof entry[1] === "string" && !!entry[1]
      )),
    );
  } catch {
    return {};
  }
}

function loadFolderUnlockTokenMap(): Record<string, string> {
  const value = readRawFolderUnlockTokenMap();
  try {
    const currentUserId = tokenPayload(localStorage.getItem("nowen-token") || "")?.userId;
    const now = Math.floor(Date.now() / 1000);
    if (!currentUserId) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => {
        const payload = tokenPayload(entry[1]);
        return payload?.userId === currentUserId && (!payload.exp || payload.exp > now);
      }),
    );
  } catch {
    return {};
  }
}

function writeFolderUnlockTokenMap(next: Record<string, string>): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
  } catch {
    // 会话存储不可用时仍允许当前组件维持解锁状态。
  }
}

function broadcastLock(reason: KnowledgeTreeFolderLockReason): void {
  try {
    const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    localStorage.setItem(KNOWLEDGE_TREE_PASSWORD_LOCK_BROADCAST_KEY, JSON.stringify({
      reason,
      at: Date.now(),
      nonce,
    }));
  } catch {
    // 隐私模式或受限 WebView 中无法广播时，当前窗口仍会正常锁定。
  }
}

export function loadUnlockedFolderIds(): Set<string> {
  return new Set(Object.keys(loadFolderUnlockTokenMap()));
}

export function getFolderUnlockSessionSnapshot(): FolderUnlockSessionSnapshot {
  const map = loadFolderUnlockTokenMap();
  let earliestExpiresAt: number | null = null;
  for (const token of Object.values(map)) {
    const exp = tokenPayload(token)?.exp;
    if (!exp) continue;
    const expiresAt = exp * 1000;
    earliestExpiresAt = earliestExpiresAt === null
      ? expiresAt
      : Math.min(earliestExpiresAt, expiresAt);
  }
  return {
    folderIds: new Set(Object.keys(map)),
    earliestExpiresAt,
  };
}

export function loadFolderUnlockTokens(): string[] {
  return Object.values(loadFolderUnlockTokenMap());
}

export function folderUnlockRequestHeaders(): Record<string, string> {
  const tokens = loadFolderUnlockTokens();
  return tokens.length > 0 ? { "X-Folder-Unlock-Tokens": tokens.join(",") } : {};
}

export function rememberUnlockedFolder(nodeId: string, unlockToken: string): Set<string> {
  const next = loadFolderUnlockTokenMap();
  next[nodeId] = unlockToken;
  writeFolderUnlockTokenMap(next);
  emitSessionChanged();
  return new Set(Object.keys(next));
}

export function forgetUnlockedFolder(nodeId: string): Set<string> {
  const next = loadFolderUnlockTokenMap();
  delete next[nodeId];
  writeFolderUnlockTokenMap(next);
  emitSessionChanged();
  return new Set(Object.keys(next));
}

export function clearFolderUnlockTokens(options: {
  reason?: KnowledgeTreeFolderLockReason;
  broadcast?: boolean;
} = {}): void {
  const folderIds = Object.keys(readRawFolderUnlockTokenMap());
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // 会话存储不可用时只通知当前界面重新读取状态。
  }
  const reason = options.reason || "manual";
  emitSessionChanged();
  emitLocked(reason, folderIds);
  if (options.broadcast) broadcastLock(reason);
}

export function isFolderUnlocked(node: KnowledgeTreeNode, unlockedIds: Set<string>): boolean {
  return node.isPasswordProtected !== 1 || unlockedIds.has(node.id);
}

export function hideLockedFolderDescendants(
  nodes: KnowledgeTreeNode[],
  unlockedIds: Set<string>,
): KnowledgeTreeNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter((node) => {
    let parent = node.parentId ? byId.get(node.parentId) : undefined;
    const visited = new Set<string>();
    while (parent && !visited.has(parent.id)) {
      if (!isFolderUnlocked(parent, unlockedIds)) return false;
      visited.add(parent.id);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return true;
  });
}
