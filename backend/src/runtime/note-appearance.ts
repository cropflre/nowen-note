import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import { hasPermission, resolveNotePermission } from "../middleware/acl.js";
import { DEFAULT_NOTE_THEME_ID, normalizeNoteThemeId } from "../lib/noteThemeId.js";

export { DEFAULT_NOTE_THEME_ID, normalizeNoteThemeId } from "../lib/noteThemeId.js";

const ROUTE_PATCH_FLAG = Symbol.for("nowen.noteAppearance.routePatch");
const ROUTER_INSTALLED_FLAG = Symbol.for("nowen.noteAppearance.routerInstalled");
const globals = globalThis as typeof globalThis & Record<symbol, boolean>;

let schemaReadyFor: ReturnType<typeof getDb> | null = null;

/**
 * Note appearance is note metadata, not editor content. Keep the schema additive and idempotent so
 * database restore/reopen paths can safely re-enter the capability without mutating note bodies.
 */
export function ensureNoteAppearanceSchema(): void {
  const db = getDb();
  if (schemaReadyFor === db) return;
  const columns = db.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "themeId")) {
    db.prepare("ALTER TABLE notes ADD COLUMN themeId TEXT").run();
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notes_theme_id ON notes(themeId);
  `);
  schemaReadyFor = db;
}

/**
 * NULL means "inherit the account/notebook default". `default` is a real explicit theme choice,
 * which matters when an account default is Paper but one note intentionally wants Nowen Default.
 */
const router = new Hono();

router.get("/:id", (c) => {
  ensureNoteAppearanceSchema();
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("id");
  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "read")) {
    return c.json({ error: "无权访问该笔记", code: "FORBIDDEN" }, 403);
  }
  const row = getDb().prepare("SELECT themeId FROM notes WHERE id = ?").get(noteId) as
    | { themeId: string | null }
    | undefined;
  if (!row) return c.json({ error: "Note not found", code: "NOT_FOUND" }, 404);
  return c.json({ noteId, themeId: row.themeId || null });
});

router.put("/:id", async (c) => {
  ensureNoteAppearanceSchema();
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("id");
  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "无权修改该笔记外观", code: "FORBIDDEN" }, 403);
  }

  const body = await c.req.json().catch(() => ({})) as { themeId?: unknown };
  if (!("themeId" in body)) {
    return c.json({ error: "缺少 themeId", code: "THEME_ID_REQUIRED" }, 400);
  }
  const requested = body.themeId;
  const normalized = normalizeNoteThemeId(requested);
  const wantsInheritance = requested == null || requested === "";
  if (!wantsInheritance && normalized === null) {
    return c.json({ error: "无效的主题标识", code: "INVALID_THEME_ID" }, 400);
  }

  const db = getDb();
  const existing = db.prepare("SELECT id, themeId FROM notes WHERE id = ?").get(noteId) as
    | { id: string; themeId: string | null }
    | undefined;
  if (!existing) return c.json({ error: "Note not found", code: "NOT_FOUND" }, 404);

  if ((existing.themeId || null) !== normalized) {
    // Appearance is metadata. Keep it observable via updatedAt without creating a content version.
    db.prepare("UPDATE notes SET themeId = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(normalized, noteId);
  }

  return c.json({
    noteId,
    themeId: normalized,
    updated: (existing.themeId || null) !== normalized,
  });
});

function installNoteAppearanceRoute(app: Hono<any>): void {
  const tagged = app as Hono<any> & Record<symbol, boolean>;
  if (tagged[ROUTER_INSTALLED_FLAG]) return;
  tagged[ROUTER_INSTALLED_FLAG] = true;
  ensureNoteAppearanceSchema();
  app.route("/api/note-appearance", router);
}

if (!globals[ROUTE_PATCH_FLAG]) {
  globals[ROUTE_PATCH_FLAG] = true;
  const prototype = Hono.prototype as any;
  const nativeRoute = prototype.route as (this: Hono<any>, path: string, subApp: Hono<any>) => Hono<any>;
  prototype.route = function patchedRoute(this: Hono<any>, path: string, subApp: Hono<any>) {
    if (path === "/api/notes") installNoteAppearanceRoute(this);
    return nativeRoute.call(this, path, subApp);
  };
}
