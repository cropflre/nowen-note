import type { Context, Next } from "hono";

import {
  hasKnowledgeCapability,
  resolveResourceKnowledgeAccess,
  resolveResourceKnowledgeAccessForTombstone,
  type KnowledgeCapabilityName,
} from "../services/knowledgeCapabilities.js";

const UUID_SEGMENT = "([0-9a-fA-F-]{36})";
type GuardedResourceType = "note" | "notebook";
type ResourceAccessOptions = { includeDeleted?: boolean };

function forbidden(c: Context, required: KnowledgeCapabilityName, nodeId: string) {
  return c.json({
    error: "权限不足",
    code: "KNOWLEDGE_CAPABILITY_FORBIDDEN",
    required,
    nodeId,
  }, 403);
}

function hiddenResource(c: Context) {
  return c.json({ error: "资源不存在", code: "NOT_FOUND" }, 404);
}

function resourceAccess(
  resourceType: GuardedResourceType,
  resourceId: string,
  userId: string,
  capability: KnowledgeCapabilityName,
  options: ResourceAccessOptions = {},
) {
  const access = options.includeDeleted
    ? resolveResourceKnowledgeAccessForTombstone(resourceType, resourceId, userId)
    : resolveResourceKnowledgeAccess(resourceType, resourceId, userId);
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

/**
 * Legacy list routes query by workspace membership. Post-filter their JSON arrays
 * through the unified knowledge capability resolver so restricted descendants do
 * not leak into sidebar caches, search results or offline synchronization.
 *
 * Recycle-bin note rows are a special lifecycle view: their knowledge-tree node
 * is intentionally tombstoned, but the user still needs the pre-delete ACL to
 * view/restore/delete it. Only those rows opt into tombstone-aware resolution.
 */
async function filterCollectionResponse(
  c: Context,
  next: Next,
  resourceType: GuardedResourceType,
): Promise<void> {
  await next();
  if (!c.res.ok) return;
  const contentType = c.res.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return;

  let payload: unknown;
  try {
    payload = await c.res.clone().json();
  } catch {
    return;
  }
  if (!Array.isArray(payload)) return;

  const userId = c.req.header("X-User-Id") || "";
  const filtered = payload.filter((row) => {
    const id = row && typeof row === "object" && typeof (row as any).id === "string"
      ? (row as any).id
      : "";
    if (!id) return false;
    const includeDeleted = resourceType === "note" && Number((row as any).isTrashed) === 1;
    return resourceAccess(resourceType, id, userId, "canView", { includeDeleted }).allowed;
  });

  if (filtered.length === payload.length) return;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=UTF-8");
  c.res = new Response(JSON.stringify(filtered), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
}

export async function enforceKnowledgeNoteCapabilities(c: Context, next: Next) {
  const method = c.req.method.toUpperCase();
  const userId = c.req.header("X-User-Id") || "";
  const path = c.req.path;

  if (method === "GET" && /^\/api\/notes\/?$/.test(path)) {
    return filterCollectionResponse(c, next, "note");
  }
  if (method === "OPTIONS") return next();

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

  if (method === "GET" || method === "HEAD") {
    const checked = resourceAccess("note", noteId, userId, "canView");
    return checked.allowed ? next() : hiddenResource(c);
  }

  if (method === "DELETE") {
    // Permanent delete is a recycle-bin lifecycle action. The tree node may
    // already be tombstoned, so evaluate the original ACL without resurfacing it.
    const checked = resourceAccess("note", noteId, userId, "canManageMembers", { includeDeleted: true });
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
    // Soft-delete and restore share the isTrashed field. On restore the resource
    // is already a tombstone, so only this lifecycle capability may look through
    // the deleted marker. Edit/move/manage checks remain strict.
    const includeDeleted = capability === "canDelete" && body.isTrashed !== undefined;
    const checked = resourceAccess("note", noteId, userId, capability, { includeDeleted });
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
  const userId = c.req.header("X-User-Id") || "";
  const path = c.req.path;

  if (method === "GET" && /^\/api\/notebooks\/?$/.test(path)) {
    return filterCollectionResponse(c, next, "notebook");
  }
  if (method === "OPTIONS") return next();

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

  if (method === "GET" || method === "HEAD") {
    const checked = resourceAccess("notebook", notebookId, userId, "canView");
    return checked.allowed ? next() : hiddenResource(c);
  }

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
