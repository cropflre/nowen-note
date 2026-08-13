import * as Y from "yjs";
import { Hono, type Context } from "hono";
import { getDb } from "../db/schema.js";
import { hasPermission, resolveNotePermission } from "../middleware/acl.js";
import { noteYsnapshotsRepository, noteYupdatesRepository } from "../repositories/index.js";
import { yDestroyDoc } from "../services/yjs.js";

const ROUTE_PATCH_FLAG = Symbol.for("nowen.noteFormatYjsTransition.routePatch");
const ROUTE_INSTALLED_FLAG = Symbol.for("nowen.noteFormatYjsTransition.routeInstalled");
const globals = globalThis as typeof globalThis & Record<symbol, boolean>;

/**
 * Retire the Markdown collaboration epoch without forgetting its causal history.
 *
 * Why this is required:
 * - Markdown collaboration is persisted both on the server and in browser IndexedDB.
 * - The old release-room route deleted the server snapshot/update history when switching MD -> RTE,
 *   but browser IndexedDB deliberately survived so offline edits were not lost on ordinary reloads.
 * - Switching RTE -> MD later created a brand-new server Y.Doc. When the browser opened Markdown
 *   again, Yjs saw the stale IndexedDB structs and the new server structs as two independent edits
 *   and merged both, making the whole document appear twice (Issue #694).
 *
 * We instead compact the previous Markdown state into an *empty tombstone snapshot*. The visible
 * text is removed, but the Yjs struct/delete-set identity is retained. When a later Markdown epoch
 * is seeded, old IndexedDB content is therefore recognized as already deleted instead of being
 * merged back as a second copy.
 */
export function retireMarkdownYjsState(noteId: string): {
  preservedCausalState: boolean;
} {
  const db = getDb();

  // Cancel any in-memory debounce that could otherwise write the old Markdown back after the
  // REST conversion has already persisted Tiptap JSON. Every accepted Y update is persisted when
  // received, so the snapshot + update log below is the durable causal source we want to retire.
  try { yDestroyDoc(noteId); } catch { /* rebuild from durable rows below */ }

  const doc = new Y.Doc();
  let appliedAny = false;
  try {
    const snapshot = noteYsnapshotsRepository.getByNoteId(noteId);
    let watermark = 0;
    if (snapshot) {
      Y.applyUpdate(doc, new Uint8Array(snapshot.snapshot_blob));
      appliedAny = true;
      watermark = snapshot.updatesMergedTo || 0;
    }

    const updates = noteYupdatesRepository.listAfterId(noteId, watermark);
    for (const row of updates) {
      Y.applyUpdate(doc, new Uint8Array(row.update_blob));
      appliedAny = true;
    }

    const ytext = doc.getText("content");
    if (ytext.length > 0) {
      doc.transact(() => {
        ytext.delete(0, ytext.length);
      }, "format-transition-retire");
    }

    // The full state now contains the old structs plus their delete-set, but no visible text.
    // It is self-contained, so the incremental log can be compacted completely.
    const tombstoneState = Buffer.from(Y.encodeStateAsUpdate(doc));
    db.transaction(() => {
      noteYupdatesRepository.deleteByNoteId(noteId);
      noteYsnapshotsRepository.upsert(noteId, tombstoneState, 0);
    })();

    return { preservedCausalState: appliedAny };
  } finally {
    doc.destroy();
  }
}

function installReleaseRoomOverride(app: Hono<any>): void {
  const tagged = app as Hono<any> & Record<symbol, boolean>;
  if (tagged[ROUTE_INSTALLED_FLAG]) return;
  tagged[ROUTE_INSTALLED_FLAG] = true;

  // Register on the parent app before /api/notes is mounted. Hono resolves routes in registration
  // order, so this safely supersedes the legacy sub-router endpoint without changing every notes
  // route during the v1.4.6 release freeze.
  app.post("/api/notes/:id/yjs/release-room", (c: Context) => {
    const userId = c.req.header("X-User-Id") || "";
    const noteId = c.req.param("id");
    const { permission } = resolveNotePermission(noteId, userId);
    if (!hasPermission(permission, "write")) {
      return c.json({ error: "需要 write 权限", code: "FORBIDDEN" }, 403);
    }

    try {
      const retired = retireMarkdownYjsState(noteId);
      return c.json({ success: true, ...retired });
    } catch (error) {
      console.warn(
        "[note-format-yjs-transition] failed to retire markdown state:",
        error instanceof Error ? error.message : error,
      );
      return c.json({ error: "release failed", code: "YJS_FORMAT_TRANSITION_FAILED" }, 500);
    }
  });
}

if (!globals[ROUTE_PATCH_FLAG]) {
  globals[ROUTE_PATCH_FLAG] = true;
  const prototype = Hono.prototype as any;
  const nativeRoute = prototype.route as (
    this: Hono<any>,
    path: string,
    subApp: Hono<any>,
  ) => Hono<any>;

  prototype.route = function patchedRoute(
    this: Hono<any>,
    path: string,
    subApp: Hono<any>,
  ) {
    if (path === "/api/notes") installReleaseRoomOverride(this);
    return nativeRoute.call(this, path, subApp);
  };
}
