import type { Context, Next } from "hono";

import {
  hasKnowledgeCapability,
  resolveResourceKnowledgeAccess,
  type KnowledgeCapabilityName,
} from "../services/knowledgeCapabilities.js";

const UUID_SEGMENT = "([0-9a-fA-F-]{36})";

function forbidden(c: Context, required: KnowledgeCapabilityName, nodeId: string) {
  return c.json({
    error: "权限不足",
    code: "KNOWLEDGE_CAPABILITY_FORBIDDEN",
    required,
    nodeId,
  }, 403);
}

function resourceAccess(
  resourceType: "note" | "notebook",
  resourceId: string,
  userId: string,
  capability: KnowledgeCapabilityName,
) {
  const access = resolveResourceKnowledgeAccess(resourceType, resourceId, userId);
  return { access, allowed: hasKnowledgeCapability(access, capability) };
}

async function clonedJson(c: Context): Promise<Record<string, any>> {
  try {
    return await c.req.raw.clone().json();
  } catch {
    return {};
  }
}

function noteIdFromPath(path: string): string | null {
  return path.match(new RegExp(`^/api/notes/${UUID_SEGMENT}(?:/|$)`))?.[1] || null;
}

function notebookIdFromPath(path: string): string | null {
  return path.match(new RegExp(`^/api/notebooks/${UUID_SEGMENT}(?:/|$)`))?.[1] || null;
}

export async function enforceKnowledgeNoteCapabilities(c: Context, next: Next) {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const userId = c.req.header("X-User-Id") || "";
  const path = c.req.path;

  if (method === "POST" && /^\/api\/notes\/?$/.test(path)) {
    const body = await clonedJson(c);
    if (typeof body.notebookId === "string" && body.notebookId) {
      const checked = resourceAccess("notebook", body.notebookId, userId, "canCreate");
      if (!checked.allowed) return forbidden(c, "canCreate", checked.access.nodeId);
    }
    return next();
  }

  if (method === "PUT" && /^\/api\/notes\/reorder\/batch\/?$/.test(path)) {
    const body = await clonedJson(c);
    for (const item of Array.isArray(body.items) ? body.items : []) {
      if (typeof item?.id !== "string") continue;
      const checked = resourceAccess("note", item.id, userId, "canMove");
      if (!checked.allowed) return forbidden(c, "canMove", checked.access.nodeId);
    }
    return next();
  }

  const noteId = noteIdFromPath(path);
  if (!noteId) return next();

  if (method === "DELETE") {
    const checked = resourceAccess("note", noteId, userId, "canManageMembers");
    return checked.allowed ? next() : forbidden(c, "canManageMembers", checked.access.nodeId);
  }

  if (method === "POST") {
    // Y.js, block-related and room lifecycle writes all mutate the note or its collaboration state.
    const checked = resourceAccess("note", noteId, userId, "canEdit");
    return checked.allowed ? next() : forbidden(c, "canEdit", checked.access.nodeId);
  }

  if (method !== "PUT" && method !== "PATCH") return next();
  const body = await clonedJson(c);
  const requirements = new Set<KnowledgeCapabilityName>();
  if (body.notebookId !== undefined || body.sortOrder !== undefined) requirements.add("canMove");
  if (body.isTrashed !== undefined) requirements.add("canDelete");
  if (body.isLocked !== undefined) requirements.add("canManageMembers");
  if (
    body.title !== undefined || body.content !== undefined || body.contentText !== undefined ||
    body.contentFormat !== undefined || body.isPinned !== undefined || body.isArchived !== undefined
  ) requirements.add("canEdit");
  if (body.isFavorite !== undefined && requirements.size === 0) requirements.add("canView");

  for (const capability of requirements) {
    const checked = resourceAccess("note", noteId, userId, capability);
    if (!checked.allowed) return forbidden(c, capability, checked.access.nodeId);
  }
  if (typeof body.notebookId === "string" && body.notebookId) {
    const target = resourceAccess("notebook", body.notebookId, userId, "canCreate");
    if (!target.allowed) return forbidden(c, "canCreate", target.access.nodeId);
  }
  return next();
}

export async function enforceKnowledgeNotebookCapabilities(c: Context, next: Next) {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const userId = c.req.header("X-User-Id") || "";
  const path = c.req.path;

  if (method === "POST" && /^\/api\/notebooks\/?$/.test(path)) {
    const body = await clonedJson(c);
    if (typeof body.parentId === "string" && body.parentId) {
      const target = resourceAccess("notebook", body.parentId, userId, "canCreate");
      if (!target.allowed) return forbidden(c, "canCreate", target.access.nodeId);
    }
    return next();
  }

  if (method === "PUT" && /^\/api\/notebooks\/reorder\/batch\/?$/.test(path)) {
    const body = await clonedJson(c);
    for (const item of Array.isArray(body.items) ? body.items : []) {
      if (typeof item?.id !== "string") continue;
      const checked = resourceAccess("notebook", item.id, userId, "canMove");
      if (!checked.allowed) return forbidden(c, "canMove", checked.access.nodeId);
    }
    return next();
  }

  const notebookId = notebookIdFromPath(path);
  if (!notebookId) return next();

  const memberOrShareMutation = /\/(members|share-link|publication|permission-overrides)(?:\/|$)/.test(path);
  if (memberOrShareMutation) {
    const checked = resourceAccess("notebook", notebookId, userId, "canManageMembers");
    return checked.allowed ? next() : forbidden(c, "canManageMembers", checked.access.nodeId);
  }

  if (method === "DELETE") {
    const checked = resourceAccess("notebook", notebookId, userId, "canDelete");
    return checked.allowed ? next() : forbidden(c, "canDelete", checked.access.nodeId);
  }

  if (method === "POST" && /\/transfer\/?$/.test(path)) {
    const checked = resourceAccess("notebook", notebookId, userId, "canMove");
    return checked.allowed ? next() : forbidden(c, "canMove", checked.access.nodeId);
  }

  if (method !== "PUT" && method !== "PATCH") return next();
  const body = await clonedJson(c);
  const moving = /\/move\/?$/.test(path) || body.parentId !== undefined || body.sortOrder !== undefined;
  const capability: KnowledgeCapabilityName = moving ? "canMove" : "canEdit";
  const checked = resourceAccess("notebook", notebookId, userId, capability);
  if (!checked.allowed) return forbidden(c, capability, checked.access.nodeId);
  if (moving && typeof body.parentId === "string" && body.parentId) {
    const target = resourceAccess("notebook", body.parentId, userId, "canCreate");
    if (!target.allowed) return forbidden(c, "canCreate", target.access.nodeId);
  }
  return next();
}
