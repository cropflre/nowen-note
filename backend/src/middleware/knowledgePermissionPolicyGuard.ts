import type { Context, Next } from "hono";

import {
  clearKnowledgeNodeRole,
  resolveKnowledgeNodeAccess,
  resolveKnowledgePermissionSubject,
} from "../services/knowledgeCapabilities.js";
import {
  getKnowledgeNodeAccessPolicy,
  setKnowledgeNodeAccessMode,
  type KnowledgeAccessMode,
} from "../services/knowledgeAccessPolicy.js";
import {
  clearKnowledgeNodeDenied,
  listKnowledgeNodeDenials,
  setKnowledgeNodeDenied,
} from "../services/knowledgeDenyPolicy.js";

const ALLOW_ROLES = new Set(["readonly", "editor", "maintainer", "admin"]);

function replaceJsonResponse(c: Context, payload: unknown, status = c.res.status): void {
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=UTF-8");
  headers.set("cache-control", "private, no-store");
  c.res = new Response(JSON.stringify(payload), {
    status,
    statusText: c.res.statusText,
    headers,
  });
}

async function readJsonResponse(c: Context): Promise<any | null> {
  const contentType = c.res.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    return await c.res.clone().json();
  } catch {
    return null;
  }
}

async function readBody(c: Context): Promise<Record<string, any>> {
  try {
    return await c.req.raw.clone().json();
  } catch {
    return {};
  }
}

function actorUserId(c: Context): string {
  return c.req.header("X-User-Id") || "";
}

function permissionPath(path: string): { nodeId: string; targetUserId?: string } | null {
  const match = path.match(/^\/api\/knowledge-tree\/?nodes\/([^/]+)\/permissions(?:\/([^/]+))?\/?$/);
  return match ? { nodeId: match[1], targetUserId: match[2] } : null;
}

function accessModePath(path: string): string | null {
  return path.match(/^\/api\/knowledge-tree\/?nodes\/([^/]+)\/access-mode\/?$/)?.[1] || null;
}

function canManage(nodeId: string, userId: string): boolean {
  return resolveKnowledgeNodeAccess(nodeId, userId).capabilities.canManageMembers;
}

function forbidden(c: Context): Response {
  return c.json({
    error: "没有成员管理权限",
    code: "KNOWLEDGE_CAPABILITY_FORBIDDEN",
    required: "canManageMembers",
  }, 403);
}

function denialRow(nodeId: string, subject: {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
}) {
  return {
    nodeId,
    userId: subject.id,
    rolePreset: "deny" as const,
    username: subject.username,
    displayName: subject.displayName,
    email: subject.email,
    capabilities: {
      canView: false,
      canComment: false,
      canCreate: false,
      canEdit: false,
      canDelete: false,
      canMove: false,
      canDownload: false,
      canReshare: false,
      canManageMembers: false,
    },
    updatedAt: new Date().toISOString(),
  };
}

/** Add explicit policy controls without duplicating the existing knowledge-tree router. */
export async function enforceKnowledgePermissionPolicies(c: Context, next: Next): Promise<void | Response> {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const userId = actorUserId(c);

  if (/^\/api\/knowledge-tree\/?roles\/?$/.test(path) && method === "GET") {
    await next();
    const payload = await readJsonResponse(c);
    if (!payload || !Array.isArray(payload.roles)) return;
    replaceJsonResponse(c, {
      ...payload,
      roles: [
        ...payload.roles,
        { id: "deny", label: "禁止访问", capabilities: [] },
      ],
    });
    return;
  }

  const modeNodeId = accessModePath(path);
  if (modeNodeId && method === "PUT") {
    if (!canManage(modeNodeId, userId)) return forbidden(c);
    const body = await readBody(c);
    const accessMode = body.accessMode as KnowledgeAccessMode;
    if (accessMode !== "inherit" && accessMode !== "restricted") {
      return c.json({ error: "无效访问模式", code: "KNOWLEDGE_ACCESS_MODE_INVALID" }, 400);
    }
    const policy = setKnowledgeNodeAccessMode({
      nodeId: modeNodeId,
      accessMode,
      actorUserId: userId,
    });
    return c.json({ success: true, ...policy });
  }

  const permission = permissionPath(path);
  if (!permission) {
    await next();
    return;
  }

  if (method === "GET" && !permission.targetUserId) {
    await next();
    if (!c.res.ok) return;
    const payload = await readJsonResponse(c);
    if (!payload || typeof payload !== "object") return;
    const denials = listKnowledgeNodeDenials(permission.nodeId).map((row) => denialRow(permission.nodeId, {
      id: row.userId,
      username: row.username,
      displayName: row.displayName,
      email: row.email,
    }));
    replaceJsonResponse(c, {
      ...payload,
      direct: [...(Array.isArray(payload.direct) ? payload.direct : []), ...denials],
      ...getKnowledgeNodeAccessPolicy(permission.nodeId),
    });
    return;
  }

  if (method === "PUT" && !permission.targetUserId) {
    const body = await readBody(c);
    const rolePreset = String(body.rolePreset || "");
    const subject = resolveKnowledgePermissionSubject(String(body.subject || body.userId || ""));

    if (rolePreset === "deny") {
      if (!canManage(permission.nodeId, userId)) return forbidden(c);
      if (!subject) {
        return c.json({ error: "用户不存在", code: "KNOWLEDGE_PERMISSION_USER_NOT_FOUND" }, 404);
      }
      if (resolveKnowledgeNodeAccess(permission.nodeId, subject.id).source === "owner") {
        return c.json({
          error: "空间所有者始终保留管理权限，不能设置为禁止访问",
          code: "KNOWLEDGE_PERMISSION_OWNER_IMMUTABLE",
        }, 409);
      }
      setKnowledgeNodeDenied({
        nodeId: permission.nodeId,
        targetUserId: subject.id,
        actorUserId: userId,
      });
      const row = denialRow(permission.nodeId, subject);
      return c.json({
        ...row,
        user: subject,
        effective: resolveKnowledgeNodeAccess(permission.nodeId, subject.id),
      });
    }

    // Clear an existing denial before the canonical route writes an allow role, so
    // the route's returned effective access is already correct. Invalid roles and
    // unknown users are left untouched and handled by the canonical validator.
    if (ALLOW_ROLES.has(rolePreset) && subject && canManage(permission.nodeId, userId)) {
      clearKnowledgeNodeDenied({
        nodeId: permission.nodeId,
        targetUserId: subject.id,
        actorUserId: userId,
      });
    }
    await next();
    return;
  }

  if (method === "DELETE" && permission.targetUserId) {
    if (!canManage(permission.nodeId, userId)) return forbidden(c);
    const allowRemoved = clearKnowledgeNodeRole({
      nodeId: permission.nodeId,
      targetUserId: permission.targetUserId,
      actorUserId: userId,
    });
    const denyRemoved = clearKnowledgeNodeDenied({
      nodeId: permission.nodeId,
      targetUserId: permission.targetUserId,
      actorUserId: userId,
    });
    return c.json({
      success: true,
      removed: allowRemoved || denyRemoved,
      effective: resolveKnowledgeNodeAccess(permission.nodeId, permission.targetUserId),
    });
  }

  await next();
}
