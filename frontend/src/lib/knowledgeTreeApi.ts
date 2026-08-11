import { getCurrentWorkspace, getServerUrl } from "@/lib/api";
import { applyKnowledgeTreeSort } from "@/lib/knowledgeTreeSort";

export type KnowledgeNodeType = "folder" | "note" | "markdown" | "word" | "mindmap" | "file";
export type KnowledgeRolePreset = "readonly" | "editor" | "maintainer" | "admin" | "deny";
export type KnowledgeAccessSource = "owner" | "direct" | "inherited" | "legacy" | "none";
export type KnowledgeAccessMode = "inherit" | "restricted";

export interface KnowledgeCapabilities {
  canView: boolean;
  canComment: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canMove: boolean;
  canDownload: boolean;
  canReshare: boolean;
  canManageMembers: boolean;
}

export interface EffectiveKnowledgeAccess {
  nodeId: string;
  rolePreset: KnowledgeRolePreset | "commenter" | "none";
  capabilities: KnowledgeCapabilities;
  source: KnowledgeAccessSource;
  sourceNodeId: string | null;
}

export interface KnowledgeTreeNode {
  id: string;
  userId: string;
  workspaceId: string | null;
  scopeKey: string;
  parentId: string | null;
  nodeType: KnowledgeNodeType;
  resourceType: "notebook" | "note" | "mindmap" | "file";
  resourceId: string;
  title: string;
  icon?: string | null;
  isPinned?: number;
  isFavorite?: number;
  isLocked?: number;
  isPasswordProtected?: number;
  contentFormat?: string | null;
  sortOrder: number;
  isExpanded: number;
  isDeleted: number;
  childCount: number;
  createdAt: string;
  updatedAt: string;
  access: EffectiveKnowledgeAccess;
  sharedRootId?: string;
  sharedDepth?: number;
}

export interface KnowledgePermissionRow {
  nodeId: string;
  userId: string;
  rolePreset: KnowledgeRolePreset;
  username: string;
  displayName: string | null;
  email: string | null;
  capabilities: KnowledgeCapabilities;
  updatedAt: string;
}

export interface KnowledgePermissionsResponse {
  direct: KnowledgePermissionRow[];
  inheritsFromParent: string | null;
  accessMode: KnowledgeAccessMode;
  isExplicit: boolean;
  currentUserAccess: EffectiveKnowledgeAccess;
}

function apiBase(): string {
  const server = (getServerUrl() || "").replace(/\/+$/, "");
  return server ? `${server}/api/knowledge-tree` : "/api/knowledge-tree";
}

function token(): string {
  try {
    return localStorage.getItem("nowen-token") || "";
  } catch {
    return "";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  const bearer = token();
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBase()}${path}`, { ...init, headers, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `请求失败 (${response.status})`) as Error & {
      status?: number;
      code?: string;
      payload?: unknown;
    };
    error.status = response.status;
    error.code = payload?.code;
    error.payload = payload;
    throw error;
  }
  return payload as T;
}

function workspaceQuery(includeDeleted = false, workspaceIdOverride?: string): string {
  const workspaceId = workspaceIdOverride || getCurrentWorkspace();
  const params = new URLSearchParams({ workspaceId });
  if (includeDeleted) params.set("includeDeleted", "1");
  return params.toString();
}

function withDisplaySort(result: { nodes: KnowledgeTreeNode[] }): { nodes: KnowledgeTreeNode[] } {
  return { nodes: applyKnowledgeTreeSort(result.nodes) };
}

export const knowledgeTreeApi = {
  list(includeDeleted = false) {
    return request<{ nodes: KnowledgeTreeNode[] }>(`/?${workspaceQuery(includeDeleted)}`).then(withDisplaySort);
  },

  listForWorkspace(workspaceId: string, includeDeleted = false) {
    return request<{ nodes: KnowledgeTreeNode[] }>(
      `/?${workspaceQuery(includeDeleted, workspaceId)}`,
    ).then(withDisplaySort);
  },

  listShared() {
    return request<{ nodes: KnowledgeTreeNode[] }>(`/shared-with-me?${workspaceQuery()}`).then(withDisplaySort);
  },

  create(input: { parentId: string | null; nodeType: "folder" | "note" | "markdown" | "word"; title: string }) {
    return request<KnowledgeTreeNode>(`/nodes?${workspaceQuery()}`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  createForWorkspace(
    workspaceId: string,
    input: { parentId: string | null; nodeType: "folder" | "note" | "markdown" | "word"; title: string },
  ) {
    return request<KnowledgeTreeNode>(`/nodes?${workspaceQuery(false, workspaceId)}`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  update(nodeId: string, input: { title?: string; isExpanded?: boolean }) {
    return request<KnowledgeTreeNode | { success: true }>(
      `/nodes/${encodeURIComponent(nodeId)}?${workspaceQuery()}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  },

  move(nodeId: string, input: { parentId: string | null; sortOrder?: number }) {
    return request<KnowledgeTreeNode>(`/nodes/${encodeURIComponent(nodeId)}/move`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  batchMove(nodeIds: string[], input: { parentId: string | null }) {
    return request<{ success: true; nodeIds: string[]; nodes: KnowledgeTreeNode[] }>("/batch/move", {
      method: "PUT",
      body: JSON.stringify({ nodeIds, ...input }),
    });
  },

  reorder(items: Array<{ id: string; sortOrder: number }>) {
    return request<{ success: true; updated: number }>("/reorder", {
      method: "PUT",
      body: JSON.stringify({ items }),
    });
  },

  remove(nodeId: string, mode: "subtree" | "promote") {
    return request<{ success: true; affectedNodeIds: string[]; promotedNodeIds: string[] }>(
      `/nodes/${encodeURIComponent(nodeId)}?mode=${mode}`,
      { method: "DELETE" },
    );
  },

  batchRemove(nodeIds: string[]) {
    return request<{ success: true; nodeIds: string[]; affectedNodeIds: string[] }>("/batch/delete", {
      method: "POST",
      body: JSON.stringify({ nodeIds }),
    });
  },

  restore(nodeId: string, includeSubtree = true) {
    return request<{ success: true; restoredNodeIds: string[] }>(
      `/nodes/${encodeURIComponent(nodeId)}/restore`,
      { method: "POST", body: JSON.stringify({ includeSubtree }) },
    );
  },

  getPermissions(nodeId: string) {
    return request<KnowledgePermissionsResponse>(`/nodes/${encodeURIComponent(nodeId)}/permissions`);
  },

  setAccessMode(nodeId: string, accessMode: KnowledgeAccessMode) {
    return request<{ success: true; accessMode: KnowledgeAccessMode; isExplicit: boolean }>(
      `/nodes/${encodeURIComponent(nodeId)}/access-mode`,
      { method: "PUT", body: JSON.stringify({ accessMode }) },
    );
  },

  setPermission(nodeId: string, subject: string, rolePreset: KnowledgeRolePreset) {
    return request<KnowledgePermissionRow & { effective: EffectiveKnowledgeAccess }>(
      `/nodes/${encodeURIComponent(nodeId)}/permissions`,
      { method: "PUT", body: JSON.stringify({ subject, rolePreset }) },
    );
  },

  clearPermission(nodeId: string, userId: string) {
    return request<{ success: true; removed: boolean; effective: EffectiveKnowledgeAccess }>(
      `/nodes/${encodeURIComponent(nodeId)}/permissions/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  },

  history(nodeId: string) {
    return request<{ history: Array<Record<string, unknown>> }>(`/nodes/${encodeURIComponent(nodeId)}/history`);
  },

  unlockFolder(nodeId: string, password: string) {
    return request<{ success: true; isPasswordProtected: boolean; unlockToken: string }>(
      `/nodes/${encodeURIComponent(nodeId)}/unlock`,
      { method: "POST", body: JSON.stringify({ password }) },
    );
  },

  setFolderPassword(nodeId: string, input: { currentPassword?: string; newPassword: string }) {
    return request<{ success: true; isPasswordProtected: true }>(
      `/nodes/${encodeURIComponent(nodeId)}/password`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  },

  removeFolderPassword(nodeId: string, currentPassword: string) {
    return request<{ success: true; isPasswordProtected: false }>(
      `/nodes/${encodeURIComponent(nodeId)}/password`,
      { method: "DELETE", body: JSON.stringify({ currentPassword }) },
    );
  },
};
