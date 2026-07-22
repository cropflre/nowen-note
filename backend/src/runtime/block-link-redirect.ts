import { Hono } from "hono";
import type { Context, Next } from "hono";

import { getDb } from "../db/schema.js";
import { blockExists, resolveSplitBlockTarget } from "../lib/noteBlockRedirects.js";
import { hasPermission, resolveNotePermission } from "../middleware/acl.js";

const BLOCK_LINK_REDIRECT_PATCH = Symbol.for("nowen.blockLinks.redirectRoutePatch");
const globals = globalThis as typeof globalThis & Record<symbol, boolean>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NoteResolutionRow {
  id: string;
  title: string;
  notebookId: string | null;
  version: number;
  updatedAt: string;
  contentText: string;
  contentFormat: string;
  isTrashed: number;
}

function readNote(noteId: string): NoteResolutionRow | null {
  return (getDb().prepare(`
    SELECT id, title, notebookId, version, updatedAt, contentText, contentFormat, isTrashed
    FROM notes WHERE id = ?
  `).get(noteId) as NoteResolutionRow | undefined) || null;
}

function canRead(noteId: string, userId: string): boolean {
  return hasPermission(resolveNotePermission(noteId, userId).permission, "read");
}

function notePayload(note: NoteResolutionRow) {
  const notebook = note.notebookId
    ? getDb().prepare("SELECT name FROM notebooks WHERE id = ?").get(note.notebookId) as { name: string } | undefined
    : undefined;
  return {
    id: note.id,
    title: note.title,
    notebookId: note.notebookId,
    notebookName: notebook?.name || null,
    version: note.version,
    updatedAt: note.updatedAt,
    excerpt: (note.contentText || "").replace(/\s+/g, " ").trim().slice(0, 240),
    contentFormat: note.contentFormat,
  };
}

async function resolveRedirect(c: Context, next: Next) {
  const raw = c.req.query("link") || "";
  const match = raw.match(/note:([0-9a-f-]{36})#blk:([A-Za-z0-9_-]+)/i);
  if (!match || !UUID_RE.test(match[1])) return next();

  const sourceNoteId = match[1].toLowerCase();
  const sourceBlockId = match[2];
  const userId = c.req.header("X-User-Id") || "";
  const source = readNote(sourceNoteId);
  if (!source || !canRead(sourceNoteId, userId)) return next();

  // Preserve the existing resolver for blocks that still live in the original active note.
  if (!source.isTrashed && blockExists(getDb(), sourceNoteId, sourceBlockId)) return next();

  const redirected = resolveSplitBlockTarget(getDb(), sourceNoteId, sourceBlockId);
  if (!redirected) return next();
  const target = readNote(redirected.noteId);
  if (!target || target.isTrashed || !canRead(target.id, userId)) return next();

  const block = redirected.blockId
    ? blockExists(getDb(), target.id, redirected.blockId)
    : null;
  if (redirected.blockId && !block) return next();

  return c.json({
    note: notePayload(target),
    block,
    redirect: {
      redirected: true,
      fromNoteId: sourceNoteId,
      fromBlockId: sourceBlockId,
      toNoteId: target.id,
      toBlockId: redirected.blockId,
      operationId: redirected.operationId,
      hops: redirected.hops,
      chain: redirected.redirectedFrom,
    },
  });
}

/**
 * Mount a tiny resolver before the existing /api/blocks routes. All ordinary requests continue to
 * the original router, so block search/write/backlink behavior remains untouched.
 */
if (!globals[BLOCK_LINK_REDIRECT_PATCH]) {
  globals[BLOCK_LINK_REDIRECT_PATCH] = true;
  const prototype = Hono.prototype as any;
  const nativeRoute = prototype.route as (this: Hono<any>, path: string, subApp: Hono<any>) => Hono<any>;
  prototype.route = function patchedRoute(this: Hono<any>, path: string, subApp: Hono<any>) {
    if (path !== "/api/blocks") return nativeRoute.call(this, path, subApp);
    const wrapper = new Hono<any>();
    wrapper.get("/resolve", resolveRedirect);
    wrapper.route("/", subApp);
    return nativeRoute.call(this, path, wrapper);
  };
}
