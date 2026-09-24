import type Database from "better-sqlite3";

const MINDMAP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKDOWN_EMBED_RE = /!\\[\\[mindmap:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\]\\]/gi;
const HTML_EMBED_RE = /data-nowen-block-embed=["\']mindmap:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["\']/gi;

const MAX_SHARED_MINDMAPS = 20;
const MAX_SINGLE_DATA_BYTES = 512 * 1024;
const MAX_TOTAL_DATA_BYTES = 2 * 1024 * 1024;

export interface SharedMindMapSnapshot {
  id: string;
  title: string;
  data: string;
  updatedAt: string;
}

function addId(ids: string[], candidate: unknown): void {
  if (typeof candidate !== "string") return;
  const normalized = candidate.trim().toLowerCase();
  if (!MINDMAP_ID_RE.test(normalized) || ids.includes(normalized)) return;
  if (ids.length < MAX_SHARED_MINDMAPS) ids.push(normalized);
}

function extractFromMarkdown(content: string): string[] {
  const protectedContent = content.replace(/```[\\s\\S]*?```|~~~[\\s\\S]*?~~~/g, () => "\\u0000NOWEN_MINDMAP_CODE\\u0000");
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  MARKDOWN_EMBED_RE.lastIndex = 0;
  while ((match = MARKDOWN_EMBED_RE.exec(protectedContent)) !== null) addId(ids, match[1]);
  return ids;
}

function extractFromTiptap(content: string): string[] {
  const ids: string[] = [];
  try {
    const document = JSON.parse(content) as any;
    const walk = (node: any) => {
      if (!node || ids.length >= MAX_SHARED_MINDMAPS) return;
      if (node.type === "blockEmbed") {
        const href = String(node.attrs?.href || "");
        if (href.toLowerCase().startsWith("mindmap:")) addId(ids, href.slice("mindmap:".length));
      }
      if (Array.isArray(node.content)) node.content.forEach(walk);
    };
    walk(document);
  } catch {
    // Malformed historical content is handled by the fallbacks below.
  }
  return ids;
}

function extractFromHtml(content: string): string[] {
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  HTML_EMBED_RE.lastIndex = 0;
  while ((match = HTML_EMBED_RE.exec(content)) !== null) addId(ids, match[1]);
  return ids;
}

export function extractSharedMindMapIds(content: string, contentFormat?: string | null): string[] {
  if (!content) return [];
  const format = String(contentFormat || "").toLowerCase();
  if (format === "tiptap-json") {
    const ids = extractFromTiptap(content);
    if (ids.length > 0) return ids;
  }
  if (format === "markdown" || format === "md") return extractFromMarkdown(content);

  const ids = extractFromTiptap(content);
  for (const id of extractFromMarkdown(content)) addId(ids, id);
  for (const id of extractFromHtml(content)) addId(ids, id);
  return ids;
}

function isSameResourceScope(mapWorkspaceId: string | null, noteWorkspaceId: string | null): boolean {
  return (mapWorkspaceId || null) === (noteWorkspaceId || null);
}

function canOwnerReadMap(
  db: Database.Database,
  row: { userId: string; workspaceId: string | null },
  noteOwnerId: string,
): boolean {
  if (!row.workspaceId) return row.userId === noteOwnerId;
  const membership = db.prepare(
    "SELECT 1 FROM workspace_members WHERE workspaceId = ? AND userId = ? LIMIT 1",
  ).get(row.workspaceId, noteOwnerId);
  return Boolean(membership);
}

/**
 * Public shares never call the authenticated mindmap endpoint.
 * Only explicitly embedded IDs are resolved, using the note owner current access
 * and the same personal/workspace boundary. Payload size is bounded.
 */
export function collectSharedMindMapSnapshots(
  db: Database.Database,
  options: {
    content: string;
    contentFormat?: string | null;
    noteOwnerId: string;
    noteWorkspaceId: string | null;
  },
): Record<string, SharedMindMapSnapshot> {
  const ids = extractSharedMindMapIds(options.content, options.contentFormat);
  if (ids.length === 0) return {};

  const snapshots: Record<string, SharedMindMapSnapshot> = {};
  let totalBytes = 0;

  for (const id of ids) {
    const row = db.prepare(
      "SELECT id, userId, workspaceId, title, data, updatedAt FROM mindmaps WHERE id = ?",
    ).get(id) as
      | {
          id: string;
          userId: string;
          workspaceId: string | null;
          title: string;
          data: string;
          updatedAt: string;
        }
      | undefined;

    if (!row) continue;
    if (!isSameResourceScope(row.workspaceId, options.noteWorkspaceId)) continue;
    if (!canOwnerReadMap(db, row, options.noteOwnerId)) continue;

    const bytes = Buffer.byteLength(row.data || "", "utf8");
    if (bytes <= 0 || bytes > MAX_SINGLE_DATA_BYTES || totalBytes + bytes > MAX_TOTAL_DATA_BYTES) continue;

    try {
      const parsed = JSON.parse(row.data);
      if (!parsed?.root || !Array.isArray(parsed.root.children)) continue;
    } catch {
      continue;
    }

    snapshots[row.id.toLowerCase()] = {
      id: row.id.toLowerCase(),
      title: row.title || "思维导图",
      data: row.data,
      updatedAt: row.updatedAt,
    };
    totalBytes += bytes;
  }

  return snapshots;
}
