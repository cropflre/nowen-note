import type { Context, Next } from "hono";

import { getDb } from "../db/schema.js";
import { projectMarkdownNoteForUser } from "../lib/markdownUserContent.js";
import { getUserWorkspaceRole } from "./acl.js";
import {
  hasKnowledgeCapability,
  resolveResourceKnowledgeAccess,
} from "../services/knowledgeCapabilities.js";
import {
  createMarkdownExportJob,
  MarkdownExportBusyError,
  type PreparedMarkdownNote,
} from "../services/markdownExportJobs.js";

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
  if (!c.res.ok) return null;
  const contentType = c.res.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    return await c.res.clone().json();
  } catch {
    return null;
  }
}

function teamWorkspaceId(c: Context): string | null {
  const value = (c.req.query("workspaceId") || "").trim();
  return value && value !== "personal" ? value : null;
}

function noteAccess(noteId: string, userId: string) {
  return resolveResourceKnowledgeAccess("note", noteId, userId);
}

function canViewNote(noteId: string, userId: string): boolean {
  return hasKnowledgeCapability(noteAccess(noteId, userId), "canView");
}

function canEditNote(noteId: string, userId: string): boolean {
  return hasKnowledgeCapability(noteAccess(noteId, userId), "canEdit");
}

function canDownloadNote(noteId: string, userId: string): boolean {
  return hasKnowledgeCapability(noteAccess(noteId, userId), "canDownload");
}

function exportRows(workspaceId: string, userId: string): any[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT n.id, n.title, n.content, n.contentText, n.createdAt, n.updatedAt,
           n.notebookId AS notebookId,
           nb.name AS notebookName,
           n.contentFormat
    FROM notes n
    LEFT JOIN notebooks nb ON nb.id = n.notebookId
    WHERE n.workspaceId = ? AND n.isTrashed = 0
    ORDER BY nb.name, n.title
  `).all(workspaceId) as any[];
  return rows
    .filter((row) => canDownloadNote(row.id, userId))
    .map((row) => projectMarkdownNoteForUser(db, row));
}

async function handleTeamMarkdownExportJob(c: Context, workspaceId: string, userId: string): Promise<Response> {
  const body = await c.req.json().catch(() => null) as {
    notes?: PreparedMarkdownNote[];
    inlineImages?: boolean;
    layout?: "notebooks" | "flat";
    filenameBase?: string;
  } | null;
  const notes = body?.notes;
  if (!Array.isArray(notes) || notes.length === 0) {
    return c.json({ error: "没有可导出的笔记", code: "NO_NOTES" }, 400);
  }

  const noteIds = notes.map((note) => note?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (noteIds.length !== notes.length || new Set(noteIds).size !== noteIds.length) {
    return c.json({ error: "导出笔记列表包含无效或重复 ID", code: "INVALID_NOTE_IDS" }, 400);
  }

  const db = getDb();
  const rows = db.prepare(`
    SELECT id, workspaceId
    FROM notes
    WHERE id IN (${noteIds.map(() => "?").join(",")}) AND isTrashed = 0
  `).all(...noteIds) as Array<{ id: string; workspaceId: string | null }>;
  const inWorkspace = new Set(rows.filter((row) => row.workspaceId === workspaceId).map((row) => row.id));
  if (noteIds.some((id) => !inWorkspace.has(id) || !canDownloadNote(id, userId))) {
    return c.json({ error: "部分笔记不存在或无导出权限", code: "NOTE_SCOPE_MISMATCH" }, 404);
  }

  try {
    const job = createMarkdownExportJob({
      userId,
      notes,
      inlineImages: body?.inlineImages === true,
      layout: body?.layout === "flat" ? "flat" : "notebooks",
      filenameBase: typeof body?.filenameBase === "string" ? body.filenameBase : undefined,
    });
    return c.json({ job }, 202);
  } catch (error) {
    if (error instanceof MarkdownExportBusyError) {
      return c.json({ error: error.message, code: error.code }, 409);
    }
    throw error;
  }
}

/** Export handlers use effective download rights instead of note creator ownership. */
export async function enforceKnowledgeExportCapabilities(c: Context, next: Next): Promise<void | Response> {
  const workspaceId = teamWorkspaceId(c);
  if (!workspaceId) {
    await next();
    return;
  }

  const userId = c.req.header("X-User-Id") || "";
  const path = c.req.path.replace(/\/+$/, "");
  const method = c.req.method.toUpperCase();

  if (method === "POST" && path.endsWith("/markdown-package/jobs")) {
    return handleTeamMarkdownExportJob(c, workspaceId, userId);
  }

  await next();
  if (method === "GET" && path.endsWith("/notes") && c.res.ok) {
    replaceJsonResponse(c, exportRows(workspaceId, userId));
  }
}

function noteIdFromTagPath(path: string): string | null {
  const match = path.match(/^\/api\/tags\/note\/([^/]+)\/tag\/[^/]+\/?$/);
  return match?.[1] || null;
}

function tagCountsForVisibleNotes(workspaceId: string, userId: string): Map<string, number> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT nt.tagId, nt.noteId
    FROM note_tags nt
    JOIN notes n ON n.id = nt.noteId
    WHERE n.workspaceId = ? AND n.isTrashed = 0
  `).all(workspaceId) as Array<{ tagId: string; noteId: string }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!canViewNote(row.noteId, userId)) continue;
    counts.set(row.tagId, (counts.get(row.tagId) || 0) + 1);
  }
  return counts;
}

/** Tag metadata and note-tag mutations follow the target note's effective access. */
export async function enforceKnowledgeTagCapabilities(c: Context, next: Next): Promise<void | Response> {
  const userId = c.req.header("X-User-Id") || "";
  const path = c.req.path;
  const noteId = noteIdFromTagPath(path);
  if (noteId) {
    const access = noteAccess(noteId, userId);
    if (!hasKnowledgeCapability(access, "canView")) {
      return c.json({ error: "笔记不存在", code: "NOTE_NOT_FOUND" }, 404);
    }
    if (!hasKnowledgeCapability(access, "canEdit")) {
      return c.json({ error: "没有修改该笔记标签的权限", code: "FORBIDDEN" }, 403);
    }
  }

  await next();
  if (c.req.method.toUpperCase() !== "GET") return;
  const workspaceId = teamWorkspaceId(c);
  if (!workspaceId || !/^\/api\/tags\/?$/.test(path)) return;

  const payload = await readJsonResponse(c);
  if (!Array.isArray(payload)) return;
  const counts = tagCountsForVisibleNotes(workspaceId, userId);
  const role = getUserWorkspaceRole(workspaceId, userId);
  const canManageAllTags = role === "owner" || role === "admin";
  const includeEmpty = c.req.query("includeEmpty") === "true";

  const rows = payload
    .map((tag: any) => ({ ...tag, noteCount: counts.get(tag.id) || 0 }))
    .filter((tag: any) =>
      tag.noteCount > 0
      || tag.userId === userId
      || (includeEmpty && canManageAllTags),
    );
  replaceJsonResponse(c, rows);
}
