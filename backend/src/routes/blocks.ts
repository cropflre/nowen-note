import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { hasPermission, resolveNotePermission } from "../middleware/acl";
import { logAudit } from "../services/audit";
import { syncNoteLinks } from "../lib/noteLinks";
import { rebuildBlockAuthorityStore } from "../lib/blockAuthorityStore";
import { rebuildYjsSubdocumentsIfEnabled } from "../services/yjs-subdocuments";
import {
  ensureNoteIndexed,
  getNoteBlock,
  getNoteBlocks,
  plainTextFromNoteContent,
  searchNoteBlocks,
  syncNoteBlocks,
  type NoteBlockIndexRow,
  type NoteBlockType,
} from "../lib/noteBlocks";

const app = new Hono();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;

interface NoteRecord {
  id: string;
  userId: string;
  notebookId: string;
  title: string;
  content: string;
  contentText: string;
  contentFormat: string;
  version: number;
  isLocked: number;
  isTrashed: number;
  updatedAt: string;
}

function allowedNotebookIds(header: string | undefined): string[] | undefined {
  if (header == null) return undefined;
  return header.split(",").map((value) => value.trim()).filter(Boolean);
}

function readNote(noteId: string): NoteRecord | null {
  return (getDb().prepare(`
    SELECT id, userId, notebookId, title, content, contentText, contentFormat,
           version, isLocked, isTrashed, updatedAt
    FROM notes WHERE id = ?
  `).get(noteId) as NoteRecord | undefined) || null;
}

function requireNote(c: any, noteId: string, permission: "read" | "write"):
  | { note: NoteRecord; userId: string }
  | Response {
  const userId = c.req.header("X-User-Id") || "";
  const note = readNote(noteId);
  if (!note || note.isTrashed) return c.json({ error: "笔记不存在", code: "NOT_FOUND" }, 404);
  const resolved = resolveNotePermission(noteId, userId);
  if (!hasPermission(resolved.permission, permission)) {
    return c.json({ error: "笔记不存在或无权限", code: "NOT_FOUND" }, 404);
  }
  return { note, userId };
}

function serializeResult(result: unknown): string {
  return JSON.stringify(result);
}

function readIdempotentResult(userId: string, operationId: string): unknown | null {
  const row = getDb().prepare(`
    SELECT resultJson FROM block_operations WHERE userId = ? AND operationId = ?
  `).get(userId, operationId) as { resultJson: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.resultJson); } catch { return null; }
}

function storeIdempotentResult(userId: string, operationId: string, noteId: string, result: unknown): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO block_operations (userId, operationId, noteId, resultJson, createdAt)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(userId, operationId, noteId, serializeResult(result));
}

function validateWriteBody(body: any): string | null {
  if (!Number.isInteger(body?.expectedNoteVersion) || body.expectedNoteVersion < 1) {
    return "expectedNoteVersion 必须是正整数";
  }
  if (typeof body?.operationId !== "string" || body.operationId.length < 8 || body.operationId.length > 128) {
    return "operationId 长度必须为 8-128";
  }
  return null;
}

function createTiptapNode(blockType: NoteBlockType, text: string, blockId: string): any {
  const textContent = text ? [{ type: "text", text }] : [];
  if (blockType === "heading") return { type: "heading", attrs: { level: 2, blockId }, content: textContent };
  if (blockType === "paragraph") return { type: "paragraph", attrs: { blockId }, content: textContent };
  if (blockType === "codeBlock") return { type: "codeBlock", attrs: { language: null, blockId }, content: textContent };
  if (blockType === "blockquote") {
    return { type: "blockquote", attrs: { blockId }, content: [{ type: "paragraph", content: textContent }] };
  }
  const item = {
    type: blockType,
    attrs: blockType === "taskItem" ? { checked: false, blockId } : { blockId },
    content: [{ type: "paragraph", content: textContent }],
  };
  return { type: blockType === "taskItem" ? "taskList" : "bulletList", content: [item] };
}

interface TiptapLocation {
  node: any;
  parent: any[];
  index: number;
  topIndex: number;
}

function findTiptapBlock(nodes: any[], blockId: string, topIndex = -1): TiptapLocation | null {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const currentTop = topIndex < 0 ? index : topIndex;
    if (node?.attrs?.blockId === blockId) return { node, parent: nodes, index, topIndex: currentTop };
    if (Array.isArray(node?.content)) {
      const nested = findTiptapBlock(node.content, blockId, currentTop);
      if (nested) return nested;
    }
  }
  return null;
}

function setTiptapBlockText(node: any, text: string): void {
  const content = text ? [{ type: "text", text }] : [];
  if (["paragraph", "heading", "codeBlock"].includes(node.type)) {
    node.content = content;
    return;
  }
  const findTextContainer = (candidate: any): any | null => {
    if (!candidate || typeof candidate !== "object") return null;
    if (["paragraph", "heading", "codeBlock"].includes(candidate.type)) return candidate;
    if (!Array.isArray(candidate.content)) return null;
    for (const child of candidate.content) {
      const found = findTextContainer(child);
      if (found) return found;
    }
    return null;
  };
  const container = findTextContainer(node);
  if (container) container.content = content;
  else node.content = [{ type: "paragraph", content }];
}

function mutateTiptap(
  content: string,
  action: "create" | "update" | "delete" | "move",
  params: any,
): { content: string; affectedBlockId: string } {
  const doc = JSON.parse(content || '{"type":"doc","content":[]}');
  if (!Array.isArray(doc.content)) doc.content = [];

  if (action === "create") {
    const blockId = params.blockId || `blk_${uuid()}`;
    const newNode = createTiptapNode(params.blockType || "paragraph", String(params.text || ""), blockId);
    if (params.afterBlockId) {
      const target = findTiptapBlock(doc.content, params.afterBlockId);
      if (target) doc.content.splice(target.topIndex + 1, 0, newNode);
      else doc.content.push(newNode);
    } else doc.content.push(newNode);
    return { content: JSON.stringify(doc), affectedBlockId: blockId };
  }

  const target = findTiptapBlock(doc.content, params.blockId);
  if (!target) throw new Error("BLOCK_NOT_FOUND");
  if (action === "update") {
    setTiptapBlockText(target.node, String(params.text || ""));
  } else if (action === "delete") {
    target.parent.splice(target.index, 1);
  } else {
    const anchor = findTiptapBlock(doc.content, params.targetBlockId);
    if (!anchor || anchor.parent !== target.parent) throw new Error("BLOCK_MOVE_PARENT_MISMATCH");
    const [node] = target.parent.splice(target.index, 1);
    let destination = anchor.index;
    if (target.index < anchor.index) destination -= 1;
    if (params.position !== "before") destination += 1;
    target.parent.splice(Math.max(0, destination), 0, node);
  }
  return { content: JSON.stringify(doc), affectedBlockId: params.blockId };
}

function renderMarkdownBlock(blockType: NoteBlockType, text: string, blockId: string): string {
  const clean = text.replace(/\s+\^blk_[A-Za-z0-9_-]+\s*$/, "").trim();
  if (blockType === "heading") return `## ${clean} ^${blockId}`;
  if (blockType === "listItem") return `- ${clean} ^${blockId}`;
  if (blockType === "taskItem") return `- [ ] ${clean} ^${blockId}`;
  if (blockType === "blockquote") return `> ${clean} ^${blockId}`;
  if (blockType === "codeBlock") return `\`\`\`\n${clean}\n\`\`\`\n^${blockId}`;
  return `${clean} ^${blockId}`;
}

function mutateMarkdown(
  note: NoteRecord,
  action: "create" | "update" | "delete" | "move",
  params: any,
): { content: string; affectedBlockId: string } {
  const db = getDb();
  ensureNoteIndexed(db, note.id);
  const blocks = getNoteBlocks(db, note.id, 10000);
  const find = (id: string): NoteBlockIndexRow => {
    const block = blocks.find((item) => item.blockId === id);
    if (!block || block.startOffset == null || block.endOffset == null) throw new Error("BLOCK_NOT_FOUND");
    return block;
  };
  let content = note.content || "";

  if (action === "create") {
    const blockId = params.blockId || `blk_${uuid()}`;
    const rendered = renderMarkdownBlock(params.blockType || "paragraph", String(params.text || ""), blockId);
    if (params.afterBlockId) {
      const target = find(params.afterBlockId);
      const offset = target.endOffset as number;
      content = content.slice(0, offset).replace(/\s*$/, "") + `\n\n${rendered}\n` + content.slice(offset).replace(/^\s*/, "");
    } else content = content.replace(/\s*$/, "") + `\n\n${rendered}\n`;
    return { content, affectedBlockId: blockId };
  }

  const target = find(params.blockId);
  const start = target.startOffset as number;
  const end = target.endOffset as number;
  if (action === "update") {
    const rendered = renderMarkdownBlock(target.blockType, String(params.text || ""), target.blockId);
    content = content.slice(0, start) + rendered + (content.slice(end).startsWith("\n") ? "" : "\n") + content.slice(end);
  } else if (action === "delete") {
    content = (content.slice(0, start) + content.slice(end)).replace(/\n{3,}/g, "\n\n").trim() + "\n";
  } else {
    const anchor = find(params.targetBlockId);
    const segment = content.slice(start, end).replace(/^\s+|\s+$/g, "");
    let without = content.slice(0, start) + content.slice(end);
    let anchorStart = anchor.startOffset as number;
    let anchorEnd = anchor.endOffset as number;
    if (start < anchorStart) {
      const removed = end - start;
      anchorStart -= removed;
      anchorEnd -= removed;
    }
    const insertAt = params.position === "before" ? anchorStart : anchorEnd;
    without = without.slice(0, insertAt).replace(/\s*$/, "") + `\n\n${segment}\n\n` + without.slice(insertAt).replace(/^\s*/, "");
    content = without.replace(/\n{3,}/g, "\n\n");
  }
  return { content, affectedBlockId: target.blockId };
}

async function performWrite(c: any, action: "create" | "update" | "delete" | "move") {
  const noteId = c.req.param("noteId");
  const body = await c.req.json().catch(() => ({}));
  const error = validateWriteBody(body);
  if (error) return c.json({ error, code: "INVALID_BLOCK_OPERATION" }, 400);

  const required = requireNote(c, noteId, "write");
  if (required instanceof Response) return required;
  const { note, userId } = required;
  if (note.contentFormat === "html") {
    return c.json({ error: "HTML 笔记不支持块级写入", code: "BLOCK_FORMAT_UNSUPPORTED" }, 400);
  }
  const cached = readIdempotentResult(userId, body.operationId);
  if (cached) return c.json({ ...cached as any, idempotentReplay: true });

  if (note.isLocked) return c.json({ error: "Note is locked", code: "NOTE_LOCKED" }, 403);
  if (note.version !== body.expectedNoteVersion) {
    return c.json({ error: "Version conflict", code: "VERSION_CONFLICT", currentVersion: note.version }, 409);
  }

  if (action !== "create") body.blockId = c.req.param("blockId");
  try {
    const mutation = note.contentFormat === "tiptap-json"
      ? mutateTiptap(note.content, action, body)
      : mutateMarkdown(note, action, body);
    const db = getDb();
    const contentText = plainTextFromNoteContent(mutation.content, note.contentFormat);
    const nextVersion = note.version + 1;
    db.prepare(`
      UPDATE notes
      SET content = ?, contentText = ?, version = ?, updatedAt = datetime('now')
      WHERE id = ?
    `).run(mutation.content, contentText, nextVersion, noteId);
    const synced = syncNoteBlocks(db, noteId, mutation.content, note.contentFormat);
    syncNoteLinks(db, userId, noteId, synced.content);
    rebuildBlockAuthorityStore(db, noteId, synced.content, note.contentFormat, {
      noteVersion: nextVersion,
      operationId: body.operationId,
      operationType: `legacy-block-${action}`,
      operationJson: body,
    });
    rebuildYjsSubdocumentsIfEnabled(db, noteId, synced.content, note.contentFormat);
    const result = {
      success: true,
      noteId,
      blockId: mutation.affectedBlockId,
      action,
      version: nextVersion,
      contentChangedByNormalization: synced.changed,
    };
    storeIdempotentResult(userId, body.operationId, noteId, result);
    logAudit(userId, "note", `block_${action}`, result, { targetType: "note", targetId: noteId });
    return c.json(result, action === "create" ? 201 : 200);
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : String(cause);
    if (code === "BLOCK_NOT_FOUND") return c.json({ error: "块不存在", code }, 404);
    if (code === "BLOCK_MOVE_PARENT_MISMATCH") {
      return c.json({ error: "当前仅支持同一父块内移动", code }, 400);
    }
    throw cause;
  }
}

app.get("/search", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const q = (c.req.query("q") || "").trim();
  if (!q) return c.json([]);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 200);
  const notebookId = c.req.query("notebookId") || undefined;
  const allowed = allowedNotebookIds(c.req.header("X-Api-Allowed-Notebook-Ids"));
  const rows = searchNoteBlocks(getDb(), q, { notebookId, allowedNotebookIds: allowed, limit });
  return c.json(rows.filter((row) => hasPermission(resolveNotePermission(row.noteId, userId).permission, "read")));
});

app.get("/resolve", (c) => {
  const raw = c.req.query("link") || "";
  const match = raw.match(/note:([0-9a-f-]{36})(?:#blk:([A-Za-z0-9_-]+))?/i);
  if (!match || !UUID_RE.test(match[1])) return c.json({ error: "无效的内部链接", code: "INVALID_LINK" }, 400);
  const noteId = match[1].toLowerCase();
  const required = requireNote(c, noteId, "read");
  if (required instanceof Response) return required;
  ensureNoteIndexed(getDb(), noteId);
  const block = match[2] ? getNoteBlock(getDb(), noteId, match[2]) : null;
  if (match[2] && !block) return c.json({ error: "引用块不存在", code: "BLOCK_NOT_FOUND" }, 404);
  const notebook = getDb().prepare("SELECT name FROM notebooks WHERE id = ?").get(required.note.notebookId) as
    | { name: string }
    | undefined;
  return c.json({
    note: {
      id: required.note.id,
      title: required.note.title,
      notebookId: required.note.notebookId,
      notebookName: notebook?.name || null,
      version: required.note.version,
      updatedAt: required.note.updatedAt,
      excerpt: (required.note.contentText || "").replace(/\s+/g, " ").trim().slice(0, 240),
      contentFormat: required.note.contentFormat,
    },
    block,
  });
});

app.get("/graph", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const focusNoteId = c.req.query("noteId") || undefined;
  const allowed = allowedNotebookIds(c.req.header("X-Api-Allowed-Notebook-Ids"));
  const db = getDb();
  const links = db.prepare(`
    SELECT nl.sourceNoteId, nl.targetNoteId, nl.sourceBlockId, nl.targetBlockId, nl.linkType,
           s.title AS sourceTitle, s.notebookId AS sourceNotebookId,
           t.title AS targetTitle, t.notebookId AS targetNotebookId
    FROM note_links nl
    JOIN notes s ON s.id = nl.sourceNoteId AND s.isTrashed = 0
    JOIN notes t ON t.id = nl.targetNoteId AND t.isTrashed = 0
    WHERE (? IS NULL OR nl.sourceNoteId = ? OR nl.targetNoteId = ?)
    ORDER BY nl.updatedAt DESC
    LIMIT 1000
  `).all(focusNoteId || null, focusNoteId || null, focusNoteId || null) as any[];
  const visible = links.filter((link) => {
    if (allowed && (!allowed.includes(link.sourceNotebookId) || !allowed.includes(link.targetNotebookId))) return false;
    return hasPermission(resolveNotePermission(link.sourceNoteId, userId).permission, "read")
      && hasPermission(resolveNotePermission(link.targetNoteId, userId).permission, "read");
  });
  const nodes = new Map<string, any>();
  for (const link of visible) {
    nodes.set(link.sourceNoteId, { id: link.sourceNoteId, title: link.sourceTitle, notebookId: link.sourceNotebookId });
    nodes.set(link.targetNoteId, { id: link.targetNoteId, title: link.targetTitle, notebookId: link.targetNotebookId });
  }
  return c.json({ nodes: Array.from(nodes.values()), edges: visible });
});

app.get("/note/:noteId", (c) => {
  const noteId = c.req.param("noteId");
  const required = requireNote(c, noteId, "read");
  if (required instanceof Response) return required;
  ensureNoteIndexed(getDb(), noteId);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "500", 10) || 500, 1), 2000);
  return c.json({ noteId, blocks: getNoteBlocks(getDb(), noteId, limit) });
});

app.get("/:noteId/:blockId/backlinks", (c) => {
  const noteId = c.req.param("noteId");
  const blockId = c.req.param("blockId");
  const required = requireNote(c, noteId, "read");
  if (required instanceof Response) return required;
  const userId = required.userId;
  ensureNoteIndexed(getDb(), noteId);
  if (!getNoteBlock(getDb(), noteId, blockId)) return c.json({ error: "块不存在", code: "BLOCK_NOT_FOUND" }, 404);
  const rows = getDb().prepare(`
    SELECT nl.sourceNoteId, nl.sourceBlockId, nl.targetNoteId, nl.targetBlockId,
           nl.linkType, nl.linkText, nl.excerpt, n.title, n.notebookId, n.updatedAt,
           b.blockType AS sourceBlockType, b.plainText AS sourceBlockText
    FROM note_links nl
    JOIN notes n ON n.id = nl.sourceNoteId AND n.isTrashed = 0
    LEFT JOIN note_blocks_index b ON b.noteId = nl.sourceNoteId AND b.blockId = nl.sourceBlockId
    WHERE nl.targetNoteId = ? AND nl.targetBlockId = ?
    ORDER BY n.updatedAt DESC
    LIMIT 200
  `).all(noteId, blockId) as any[];
  return c.json({ backlinks: rows.filter((row) => hasPermission(resolveNotePermission(row.sourceNoteId, userId).permission, "read")) });
});

app.get("/:noteId/:blockId", (c) => {
  const noteId = c.req.param("noteId");
  const blockId = c.req.param("blockId");
  if (!BLOCK_ID_RE.test(blockId)) return c.json({ error: "无效 blockId", code: "INVALID_BLOCK_ID" }, 400);
  const required = requireNote(c, noteId, "read");
  if (required instanceof Response) return required;
  ensureNoteIndexed(getDb(), noteId);
  const block = getNoteBlock(getDb(), noteId, blockId);
  if (!block) return c.json({ error: "块不存在", code: "BLOCK_NOT_FOUND" }, 404);
  return c.json(block);
});

app.post("/:noteId", (c) => performWrite(c, "create"));
app.put("/:noteId/:blockId", (c) => performWrite(c, "update"));
app.delete("/:noteId/:blockId", (c) => performWrite(c, "delete"));
app.post("/:noteId/:blockId/move", (c) => performWrite(c, "move"));

export default app;
