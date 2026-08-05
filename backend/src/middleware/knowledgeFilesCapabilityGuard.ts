import type { Context, Next } from "hono";

import {
  knowledgeCapabilityGuardRepository,
  type KnowledgeFileListDbRow as FileListDbRow,
  type KnowledgeFileScope as FileScope,
} from "../repositories/knowledgeCapabilityGuardRepository.js";
import { createUserAttachmentAccessUrls } from "../lib/attachment-signed-url.js";
import {
  hasKnowledgeCapability,
  resolveResourceKnowledgeAccess,
} from "../services/knowledgeCapabilities.js";

const THUMBNAILABLE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/bmp",
  "image/gif",
]);

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

function attachmentNoteId(attachmentId: string): string | null {
  return knowledgeCapabilityGuardRepository.getAttachmentNoteId(attachmentId);
}

function noteIdFromFileRow(row: any): string | null {
  if (typeof row?.noteId === "string") return row.noteId;
  if (typeof row?.primaryNote?.id === "string") return row.primaryNote.id;
  if (typeof row?.id === "string") return attachmentNoteId(row.id);
  return null;
}

function accessForNote(noteId: string, userId: string) {
  return resolveResourceKnowledgeAccess("note", noteId, userId);
}

function canViewFileRow(row: any, userId: string): boolean {
  const noteId = noteIdFromFileRow(row);
  return Boolean(noteId && hasKnowledgeCapability(accessForNote(noteId, userId), "canView"));
}

function canDownloadAttachment(attachmentId: string, userId: string): boolean {
  const noteId = attachmentNoteId(attachmentId);
  return Boolean(noteId && hasKnowledgeCapability(accessForNote(noteId, userId), "canDownload"));
}

function filterAccessUrls(value: unknown, userId: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([attachmentId, url]) =>
      typeof url === "string" && canDownloadAttachment(attachmentId, userId),
    ),
  ) as Record<string, string>;
}

function sanitizeFileRow(row: any, userId: string): any | null {
  if (!canViewFileRow(row, userId)) return null;
  const attachmentId = typeof row?.id === "string" ? row.id : "";
  const downloadable = attachmentId ? canDownloadAttachment(attachmentId, userId) : false;
  const references = Array.isArray(row?.references)
    ? row.references.filter((reference: any) => {
        const noteId = typeof reference?.id === "string"
          ? reference.id
          : (typeof reference?.noteId === "string" ? reference.noteId : "");
        return noteId && hasKnowledgeCapability(accessForNote(noteId, userId), "canView");
      })
    : row?.references;

  if (downloadable) return { ...row, references, downloadAllowed: true };
  const sanitized = { ...row, references, downloadAllowed: false };
  delete sanitized.url;
  delete sanitized.thumbnailUrl;
  delete sanitized.downloadUrl;
  return sanitized;
}

function visibleAttachmentStats(workspaceId: string | null, userId: string) {
  const rows = knowledgeCapabilityGuardRepository.listAttachmentStatsRows(workspaceId, userId);

  const byMime = new Map<string, { count: number; bytes: number }>();
  let total = 0;
  let totalBytes = 0;
  let imageCount = 0;
  let imageBytes = 0;
  let fileCount = 0;
  let fileBytes = 0;

  for (const row of rows as Array<{ id: string; noteId: string; mimeType: string; size: number }>) {
    const access = accessForNote(row.noteId, userId);
    if (!hasKnowledgeCapability(access, "canView")) continue;
    total += 1;
    totalBytes += Number(row.size || 0);
    const mime = row.mimeType || "application/octet-stream";
    const stats = byMime.get(mime) || { count: 0, bytes: 0 };
    stats.count += 1;
    stats.bytes += Number(row.size || 0);
    byMime.set(mime, stats);
    if (mime.toLowerCase().startsWith("image/")) {
      imageCount += 1;
      imageBytes += Number(row.size || 0);
    } else {
      fileCount += 1;
      fileBytes += Number(row.size || 0);
    }
  }

  return {
    total,
    totalBytes,
    images: { count: imageCount, bytes: imageBytes },
    files: { count: fileCount, bytes: fileBytes },
    byMime: [...byMime.entries()].map(([mime, value]) => ({ mime, ...value })),
  };
}

function normalizePositiveInteger(value: string | undefined, fallback: number, max?: number): number {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
  return max ? Math.min(max, normalized) : normalized;
}

function fileScope(c: Context): FileScope {
  const rawWorkspaceId = (c.req.query("workspaceId") || "").trim();
  return rawWorkspaceId && rawWorkspaceId !== "personal"
    ? { scope: "workspace", workspaceId: rawWorkspaceId }
    : { scope: "personal", workspaceId: null };
}

function buildUnreferencedSet(scope: FileScope, userId: string): Set<string> {
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const contentRows = knowledgeCapabilityGuardRepository.listNoteContents(scope, userId);
  const haystack = contentRows.map((row) => row.content).join("\n");
  const candidates = knowledgeCapabilityGuardRepository.listAttachmentCandidates(scope, userId);

  const ids = new Set<string>();
  for (const row of candidates) {
    const timestamp = new Date(
      row.createdAt && row.createdAt.includes("T")
        ? row.createdAt
        : `${(row.createdAt || "").replace(" ", "T")}Z`,
    ).getTime();
    if (Number.isFinite(timestamp) && timestamp > cutoffMs) continue;
    if (haystack.includes(`/api/attachments/${row.id}`)) continue;
    ids.add(row.id);
  }
  return ids;
}

function toFileOut(row: FileListDbRow): Record<string, unknown> {
  const mime = (row.mimeType || "").toLowerCase();
  const image = mime.startsWith("image/");
  const output: Record<string, unknown> = {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt,
    category: image ? "image" : "file",
    url: `/api/attachments/${row.id}`,
    hash: row.hash ?? null,
    folderId: row.folderId ?? null,
    folderName: row.folderName ?? null,
    primaryNote: row.noteId
      ? {
          id: row.noteId,
          title: row.noteTitle ?? "",
          notebookId: row.notebookId,
          notebookName: row.notebookName,
          notebookIcon: row.notebookIcon,
          isTrashed: row.isTrashed ?? 0,
        }
      : null,
  };
  if (image && THUMBNAILABLE_MIMES.has(mime)) {
    output.thumbnailUrl = `/api/attachments/${row.id}?w=240`;
  }
  return output;
}

/**
 * Rebuild the root file list from the complete candidate set. The legacy route applies
 * LIMIT/OFFSET before the knowledge-tree guard runs, so filtering only payload.items can
 * produce empty pages and a false total. Access must be resolved before pagination.
 */
function visibleFileList(c: Context, userId: string) {
  const scope = fileScope(c);
  const category = (c.req.query("category") || "all").toLowerCase();
  const filter = (c.req.query("filter") || "").toLowerCase();
  const page = normalizePositiveInteger(c.req.query("page"), 1);
  const pageSize = normalizePositiveInteger(c.req.query("pageSize"), 50, 200);
  const unreferencedIds = filter === "unreferenced"
    ? [...buildUnreferencedSet(scope, userId)]
    : [];
  const rows = knowledgeCapabilityGuardRepository.listFileRows({
    scope,
    userId,
    category,
    filter,
    mime: (c.req.query("mime") || "").toLowerCase(),
    notebookId: c.req.query("notebookId") || "",
    noteId: c.req.query("noteId") || "",
    folderId: c.req.query("folderId") || "",
    q: (c.req.query("q") || "").trim(),
    myUploadsRef: (c.req.query("myUploadsRef") || "").toLowerCase(),
    unreferencedIds,
    sort: c.req.query("sort") || "created_desc",
  });

  const accessCache = new Map<string, { canView: boolean; canDownload: boolean }>();
  const permissions = (noteIdValue: string) => {
    const cached = accessCache.get(noteIdValue);
    if (cached) return cached;
    const access = accessForNote(noteIdValue, userId);
    const resolved = {
      canView: hasKnowledgeCapability(access, "canView"),
      canDownload: hasKnowledgeCapability(access, "canDownload"),
    };
    accessCache.set(noteIdValue, resolved);
    return resolved;
  };

  const visibleRows = rows.filter((row) => row.noteId && permissions(row.noteId).canView);
  const start = (page - 1) * pageSize;
  const pageRows = visibleRows.slice(start, start + pageSize);
  const items = pageRows.map((row) => {
    const output = toFileOut(row);
    if (permissions(row.noteId).canDownload) return { ...output, downloadAllowed: true };
    delete output.url;
    delete output.thumbnailUrl;
    return { ...output, downloadAllowed: false };
  });
  const downloadableRows = pageRows.filter((row) => permissions(row.noteId).canDownload);

  return {
    items,
    accessUrls: createUserAttachmentAccessUrls(userId, downloadableRows),
    total: visibleRows.length,
    page,
    pageSize,
  };
}

/** Filter file-manager metadata and signed URLs through the owning note's access. */
export async function enforceKnowledgeFilesVisibility(c: Context, next: Next): Promise<void> {
  if (c.req.method.toUpperCase() !== "GET") {
    await next();
    return;
  }

  await next();
  const payload = await readJsonResponse(c);
  if (!payload || typeof payload !== "object") return;
  const userId = c.req.header("X-User-Id") || "";
  const path = c.req.path.replace(/\/+$/, "");

  if (path === "/api/files") {
    replaceJsonResponse(c, visibleFileList(c, userId));
    return;
  }

  if (path.endsWith("/stats")) {
    const rawWorkspaceId = (c.req.query("workspaceId") || "").trim();
    const workspaceId = rawWorkspaceId && rawWorkspaceId !== "personal" ? rawWorkspaceId : null;
    const stats = visibleAttachmentStats(workspaceId, userId);
    replaceJsonResponse(c, {
      ...payload,
      ...stats,
      unreferenced: { count: 0, bytes: 0 },
    });
    return;
  }

  if (Array.isArray(payload.items)) {
    const items = payload.items
      .map((row: any) => sanitizeFileRow(row, userId))
      .filter(Boolean);
    replaceJsonResponse(c, {
      ...payload,
      items,
      accessUrls: filterAccessUrls(payload.accessUrls, userId),
      total: items.length,
    });
    return;
  }

  if (typeof payload.id === "string") {
    const sanitized = sanitizeFileRow(payload, userId);
    if (!sanitized) {
      replaceJsonResponse(c, { error: "文件不存在", code: "FILE_NOT_FOUND" }, 404);
      return;
    }
    replaceJsonResponse(c, {
      ...sanitized,
      accessUrls: filterAccessUrls(payload.accessUrls, userId),
    });
  }
}
