import { Hono } from "hono";
import { getDb } from "../db/schema";
import { hasPermission, resolveNotePermission } from "../middleware/acl";
import { broadcastToUser } from "../services/realtime";

type MarkdownViewMode = "source" | "preview" | "split";
type ReadingDensity = "cozy" | "compact";

interface UserPreferences {
  noteTitleAsAppTitle: boolean;
  outlineDefaultOpen: boolean;
  lockOnOpen: boolean;
  showNotesInNotebookTree: boolean;
  readingDensity: ReadingDensity;
  showNoteListUpdatedTime: boolean;
  enableNoteTabs: boolean;
  markdownDefaultViewMode: MarkdownViewMode;
}

const DEFAULT_PREFS: UserPreferences = {
  noteTitleAsAppTitle: false,
  outlineDefaultOpen: false,
  lockOnOpen: false,
  showNotesInNotebookTree: false,
  readingDensity: "cozy",
  showNoteListUpdatedTime: true,
  enableNoteTabs: false,
  markdownDefaultViewMode: "source",
};

const MAX_NOTE_ICON_CODE_POINTS = 32;
const MAX_NOTE_ICON_BATCH = 200;
let noteIconsDatabase: object | null = null;

function ensureNoteIconsTable(): void {
  const db = getDb();
  if (noteIconsDatabase === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_icons (
      noteId TEXT PRIMARY KEY,
      icon TEXT NOT NULL,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_note_icons_updatedAt ON note_icons(updatedAt);
  `);
  noteIconsDatabase = db;
}

function normalizeNoteIcon(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "string") {
    throw new Error("icon must be a string or null");
  }
  const icon = input.trim();
  if (!icon) return null;
  if (/[\r\n\t]/.test(icon) || Array.from(icon).length > MAX_NOTE_ICON_CODE_POINTS) {
    throw new Error(`icon must contain at most ${MAX_NOTE_ICON_CODE_POINTS} characters without line breaks`);
  }
  return icon;
}

function normalizeNoteIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return Array.from(new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  )).slice(0, MAX_NOTE_ICON_BATCH);
}

function normalizePrefs(input: unknown, base: UserPreferences = DEFAULT_PREFS): UserPreferences {
  const raw = input && typeof input === "object" ? input as Partial<UserPreferences> : {};
  return {
    noteTitleAsAppTitle: typeof raw.noteTitleAsAppTitle === "boolean" ? raw.noteTitleAsAppTitle : base.noteTitleAsAppTitle,
    outlineDefaultOpen: typeof raw.outlineDefaultOpen === "boolean" ? raw.outlineDefaultOpen : base.outlineDefaultOpen,
    lockOnOpen: typeof raw.lockOnOpen === "boolean" ? raw.lockOnOpen : base.lockOnOpen,
    showNotesInNotebookTree: typeof raw.showNotesInNotebookTree === "boolean" ? raw.showNotesInNotebookTree : base.showNotesInNotebookTree,
    readingDensity: raw.readingDensity === "compact" || raw.readingDensity === "cozy" ? raw.readingDensity : base.readingDensity,
    showNoteListUpdatedTime: typeof raw.showNoteListUpdatedTime === "boolean" ? raw.showNoteListUpdatedTime : base.showNoteListUpdatedTime,
    enableNoteTabs: typeof raw.enableNoteTabs === "boolean" ? raw.enableNoteTabs : base.enableNoteTabs,
    markdownDefaultViewMode:
      raw.markdownDefaultViewMode === "source" ||
      raw.markdownDefaultViewMode === "preview" ||
      raw.markdownDefaultViewMode === "split"
        ? raw.markdownDefaultViewMode
        : base.markdownDefaultViewMode,
  };
}

function readStoredPreferences(userId: string): { prefs: UserPreferences; hasPreferences: boolean } {
  const db = getDb();
  const row = db
    .prepare("SELECT preferencesJson FROM user_preferences WHERE userId = ?")
    .get(userId) as { preferencesJson: string } | undefined;
  if (!row) return { prefs: DEFAULT_PREFS, hasPreferences: false };

  try {
    return { prefs: normalizePrefs(JSON.parse(row.preferencesJson)), hasPreferences: true };
  } catch {
    return { prefs: DEFAULT_PREFS, hasPreferences: true };
  }
}

const app = new Hono();

/**
 * Batch-load note icons for currently rendered cards.
 *
 * The endpoint intentionally accepts note IDs instead of returning the whole table:
 * - it keeps payloads bounded for users with large libraries;
 * - every requested note still goes through the existing note ACL;
 * - callers can batch up to 200 visible cards into one request.
 */
app.get("/note-icons", (c) => {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const requestedIds = normalizeNoteIds(c.req.query("ids"));
  if (requestedIds.length === 0) return c.json({ icons: {} });

  const readableIds = requestedIds.filter((noteId) => {
    const { permission } = resolveNotePermission(noteId, userId);
    return hasPermission(permission, "read");
  });
  if (readableIds.length === 0) return c.json({ icons: {} });

  ensureNoteIconsTable();
  const placeholders = readableIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT noteId, icon FROM note_icons WHERE noteId IN (${placeholders})`)
    .all(...readableIds) as Array<{ noteId: string; icon: string }>;

  return c.json({
    icons: Object.fromEntries(rows.map((row) => [row.noteId, row.icon])),
  });
});

app.get("/note-icons/:noteId", (c) => {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const noteId = c.req.param("noteId");
  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "read")) {
    return c.json({ error: "Note not found or forbidden", code: "NOT_FOUND" }, 404);
  }

  ensureNoteIconsTable();
  const row = getDb()
    .prepare("SELECT icon, updatedAt FROM note_icons WHERE noteId = ?")
    .get(noteId) as { icon: string; updatedAt: string } | undefined;
  return c.json({ noteId, icon: row?.icon ?? null, updatedAt: row?.updatedAt ?? null });
});

app.put("/note-icons/:noteId", async (c) => {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const noteId = c.req.param("noteId");
  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "权限不足", code: "FORBIDDEN" }, 403);
  }

  const note = getDb()
    .prepare("SELECT id, isLocked FROM notes WHERE id = ?")
    .get(noteId) as { id: string; isLocked: number } | undefined;
  if (!note) return c.json({ error: "Note not found", code: "NOT_FOUND" }, 404);
  if (note.isLocked === 1) {
    return c.json({ error: "Note is locked", code: "NOTE_LOCKED" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  let icon: string | null;
  try {
    icon = normalizeNoteIcon((body as { icon?: unknown }).icon);
  } catch (error) {
    return c.json({ error: (error as Error).message, code: "INVALID_NOTE_ICON" }, 400);
  }

  ensureNoteIconsTable();
  const db = getDb();
  if (icon === null) {
    db.prepare("DELETE FROM note_icons WHERE noteId = ?").run(noteId);
  } else {
    db.prepare(`
      INSERT INTO note_icons (noteId, icon, updatedAt)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(noteId) DO UPDATE SET
        icon = excluded.icon,
        updatedAt = datetime('now')
    `).run(noteId, icon);
  }

  const result = db
    .prepare("SELECT updatedAt FROM note_icons WHERE noteId = ?")
    .get(noteId) as { updatedAt: string } | undefined;

  // Same-account clients that are currently on another note/list receive the icon update too.
  try {
    broadcastToUser(userId, {
      type: "note:list-updated" as any,
      note: { id: noteId, icon },
      actorUserId: userId,
      actorConnectionId: c.req.header("X-Connection-Id") || null,
    } as any);
  } catch (error) {
    console.warn("[note-icons] broadcast failed:", error);
  }

  return c.json({ noteId, icon, updatedAt: result?.updatedAt ?? null });
});

app.get("/", (c) => {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { prefs, hasPreferences } = readStoredPreferences(userId);
  return c.json({ ...prefs, hasPreferences });
});

app.put("/", async (c) => {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const current = readStoredPreferences(userId).prefs;
  const next = normalizePrefs(body, current);

  getDb().prepare(
    `INSERT INTO user_preferences (userId, preferencesJson, updatedAt)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(userId) DO UPDATE SET
       preferencesJson = excluded.preferencesJson,
       updatedAt = datetime('now')`,
  ).run(userId, JSON.stringify(next));

  return c.json({ ...next, hasPreferences: true });
});

export default app;
