import { createHash } from "node:crypto";
import type { Context, Next } from "hono";

import { getDb } from "../db/schema.js";
import {
  hasKnowledgeCapability,
  resolveKnowledgeNodeAccess,
  resolveResourceKnowledgeAccess,
} from "../services/knowledgeCapabilities.js";

interface SyncItem {
  operation?: string;
  noteId?: string;
  note?: { id?: string; notebookId?: string };
  attachments?: Array<{ id?: string; noteId?: string; size?: number }>;
  attachmentDownloadAllowed?: boolean;
  attachmentBytes?: number;
  [key: string]: unknown;
}

function replaceJsonResponse(c: Context, payload: unknown): void {
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=UTF-8");
  headers.set("cache-control", "private, no-store");
  c.res = new Response(JSON.stringify(payload), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
}

async function readJsonResponse(c: Context): Promise<any | null> {
  if (!c.res.ok) return null;
  const contentType = c.res.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    return await c.res.clone().json();
  } catch {
    return null;
  }
}

function requestedWorkspaceId(c: Context): string | null {
  const value = (c.req.query("workspaceId") || "").trim();
  return !value || value === "personal" ? null : value;
}

function noteAccess(noteId: string, userId: string) {
  return resolveResourceKnowledgeAccess("note", noteId, userId);
}

function notebookAccess(notebookId: string, userId: string) {
  return resolveResourceKnowledgeAccess("notebook", notebookId, userId);
}

function sanitizeBundle(item: SyncItem, userId: string): SyncItem | null {
  const noteId = typeof item.note?.id === "string"
    ? item.note.id
    : (typeof item.noteId === "string" ? item.noteId : "");
  if (!noteId) return null;

  const access = noteAccess(noteId, userId);
  if (!hasKnowledgeCapability(access, "canView")) return null;

  if (!hasKnowledgeCapability(access, "canDownload")) {
    return {
      ...item,
      attachments: [],
      attachmentDownloadAllowed: false,
      attachmentBytes: 0,
    };
  }

  return item;
}

function canReceiveDeletedNote(noteId: string, userId: string): boolean {
  const db = getDb();
  const node = db.prepare(`
    SELECT id
    FROM knowledge_tree_nodes
    WHERE resourceType = 'note' AND resourceId = ?
    ORDER BY isDeleted ASC, updatedAt DESC
    LIMIT 1
  `).get(noteId) as { id: string } | undefined;
  if (!node) return false;
  return hasKnowledgeCapability(resolveKnowledgeNodeAccess(node.id, userId, db), "canView");
}

function sanitizeItems(items: unknown, userId: string): SyncItem[] {
  if (!Array.isArray(items)) return [];
  const result: SyncItem[] = [];
  for (const value of items) {
    if (!value || typeof value !== "object") continue;
    const item = value as SyncItem;
    if (item.operation === "delete") {
      const noteId = typeof item.noteId === "string" ? item.noteId : "";
      if (noteId && canReceiveDeletedNote(noteId, userId)) result.push(item);
      continue;
    }
    const sanitized = sanitizeBundle(item, userId);
    if (sanitized) result.push(sanitized);
  }
  return result;
}

function visibleWorkspaceState(workspaceId: string, userId: string) {
  const db = getDb();
  const notebooks = db.prepare(`
    SELECT id, parentId, updatedAt
    FROM notebooks
    WHERE workspaceId = ? AND isDeleted = 0
    ORDER BY id ASC
  `).all(workspaceId) as Array<{ id: string; parentId: string | null; updatedAt: string }>;
  const notes = db.prepare(`
    SELECT id, notebookId, updatedAt
    FROM notes
    WHERE workspaceId = ? AND isTrashed = 0
    ORDER BY id ASC
  `).all(workspaceId) as Array<{ id: string; notebookId: string; updatedAt: string }>;

  const visibleNotebookIds = new Set<string>();
  const notebookFingerprint: string[] = [];
  for (const row of notebooks) {
    const access = notebookAccess(row.id, userId);
    if (!hasKnowledgeCapability(access, "canView")) continue;
    visibleNotebookIds.add(row.id);
    notebookFingerprint.push(
      `notebook:${row.id}:${access.rolePreset}:${access.source}:${access.sourceNodeId || ""}:${row.updatedAt}`,
    );
  }

  const visibleNoteIds = new Set<string>();
  const downloadableNoteIds = new Set<string>();
  const noteFingerprint: string[] = [];
  for (const row of notes) {
    const access = noteAccess(row.id, userId);
    if (!hasKnowledgeCapability(access, "canView")) continue;
    visibleNoteIds.add(row.id);
    if (hasKnowledgeCapability(access, "canDownload")) downloadableNoteIds.add(row.id);
    noteFingerprint.push(
      `note:${row.id}:${access.rolePreset}:${access.source}:${access.sourceNodeId || ""}:${row.updatedAt}`,
    );
  }

  const accessFingerprint = createHash("sha256")
    .update([...notebookFingerprint, ...noteFingerprint].sort().join("\n"))
    .digest("hex");

  return { visibleNotebookIds, visibleNoteIds, downloadableNoteIds, accessFingerprint };
}

function sanitizePlan(payload: any, workspaceId: string, userId: string): any {
  const db = getDb();
  const state = visibleWorkspaceState(workspaceId, userId);
  const notebooks = Array.isArray(payload?.notebooks)
    ? payload.notebooks
        .filter((row: any) => typeof row?.id === "string" && state.visibleNotebookIds.has(row.id))
        .map((row: any) => ({
          ...row,
          parentId: row.parentId && state.visibleNotebookIds.has(row.parentId) ? row.parentId : null,
        }))
    : [];

  const attachmentRows = db.prepare(`
    SELECT noteId, size
    FROM attachments
    WHERE workspaceId = ?
  `).all(workspaceId) as Array<{ noteId: string; size: number }>;
  let attachmentCount = 0;
  let attachmentBytes = 0;
  const forbiddenNotes = new Set<string>();
  for (const row of attachmentRows) {
    if (!state.visibleNoteIds.has(row.noteId)) continue;
    if (!state.downloadableNoteIds.has(row.noteId)) {
      forbiddenNotes.add(row.noteId);
      continue;
    }
    attachmentCount += 1;
    attachmentBytes += Number(row.size || 0);
  }

  const linkedTagIds = new Set(
    (db.prepare(`
      SELECT DISTINCT nt.tagId
      FROM note_tags nt
      JOIN notes n ON n.id = nt.noteId
      WHERE n.workspaceId = ?
    `).all(workspaceId) as Array<{ tagId: string }>).filter((row) => {
      const linked = db.prepare("SELECT noteId FROM note_tags WHERE tagId = ?")
        .all(row.tagId) as Array<{ noteId: string }>;
      return linked.some((entry) => state.visibleNoteIds.has(entry.noteId));
    }).map((row) => row.tagId),
  );

  const tags = Array.isArray(payload?.tags)
    ? payload.tags.filter((tag: any) => typeof tag?.id === "string" && linkedTagIds.has(tag.id))
    : [];

  return {
    ...payload,
    accessFingerprint: state.accessFingerprint,
    noteCount: state.visibleNoteIds.size,
    attachmentCount,
    attachmentBytes,
    attachmentForbiddenNotes: forbiddenNotes.size,
    notebooks,
    tags,
  };
}

/**
 * The legacy offline-sync implementation scopes workspace data by membership only.
 * This post-filter makes snapshots, plans and change feeds obey EffectiveKnowledgeAccess.
 */
export async function enforceKnowledgeOfflineSyncVisibility(c: Context, next: Next): Promise<void> {
  if (c.req.method.toUpperCase() !== "GET") {
    await next();
    return;
  }

  const workspaceId = requestedWorkspaceId(c);
  if (!workspaceId) {
    await next();
    return;
  }

  await next();
  const payload = await readJsonResponse(c);
  if (!payload || typeof payload !== "object") return;

  const userId = c.req.header("X-User-Id") || "";
  const path = c.req.path.replace(/\/+$/, "");
  if (path.endsWith("/plan")) {
    replaceJsonResponse(c, sanitizePlan(payload, workspaceId, userId));
    return;
  }
  if (path.endsWith("/snapshot") || path.endsWith("/changes")) {
    replaceJsonResponse(c, { ...payload, items: sanitizeItems(payload.items, userId) });
  }
}
