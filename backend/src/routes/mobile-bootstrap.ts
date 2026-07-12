import { Hono } from "hono";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole } from "../middleware/acl";
import { tagsRepository } from "../repositories";
import { notebookRoleToPermission } from "../services/notebook-permissions";

const app = new Hono();

const NOTE_PREVIEW_CHARS = 280;

type ReadingDensity = "cozy" | "compact";
type MarkdownViewMode = "source" | "preview" | "split";

type UserPreferences = {
  noteTitleAsAppTitle: boolean;
  outlineDefaultOpen: boolean;
  lockOnOpen: boolean;
  showNotesInNotebookTree: boolean;
  readingDensity: ReadingDensity;
  showNoteListUpdatedTime: boolean;
  enableNoteTabs: boolean;
  markdownDefaultViewMode: MarkdownViewMode;
};

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

function normalizeWorkspaceId(raw: string | null | undefined): string | null {
  return !raw || raw === "personal" ? null : raw;
}

function normalizePreferences(input: unknown): UserPreferences {
  const raw = input && typeof input === "object" ? input as Partial<UserPreferences> : {};
  return {
    noteTitleAsAppTitle: typeof raw.noteTitleAsAppTitle === "boolean"
      ? raw.noteTitleAsAppTitle
      : DEFAULT_PREFS.noteTitleAsAppTitle,
    outlineDefaultOpen: typeof raw.outlineDefaultOpen === "boolean"
      ? raw.outlineDefaultOpen
      : DEFAULT_PREFS.outlineDefaultOpen,
    lockOnOpen: typeof raw.lockOnOpen === "boolean" ? raw.lockOnOpen : DEFAULT_PREFS.lockOnOpen,
    showNotesInNotebookTree: typeof raw.showNotesInNotebookTree === "boolean"
      ? raw.showNotesInNotebookTree
      : DEFAULT_PREFS.showNotesInNotebookTree,
    readingDensity: raw.readingDensity === "compact" || raw.readingDensity === "cozy"
      ? raw.readingDensity
      : DEFAULT_PREFS.readingDensity,
    showNoteListUpdatedTime: typeof raw.showNoteListUpdatedTime === "boolean"
      ? raw.showNoteListUpdatedTime
      : DEFAULT_PREFS.showNoteListUpdatedTime,
    enableNoteTabs: typeof raw.enableNoteTabs === "boolean"
      ? raw.enableNoteTabs
      : DEFAULT_PREFS.enableNoteTabs,
    markdownDefaultViewMode:
      raw.markdownDefaultViewMode === "source" ||
      raw.markdownDefaultViewMode === "preview" ||
      raw.markdownDefaultViewMode === "split"
        ? raw.markdownDefaultViewMode
        : DEFAULT_PREFS.markdownDefaultViewMode,
  };
}

function readPreferences(userId: string): UserPreferences & { hasPreferences: boolean } {
  const row = getDb()
    .prepare("SELECT preferencesJson FROM user_preferences WHERE userId = ?")
    .get(userId) as { preferencesJson: string } | undefined;
  if (!row) return { ...DEFAULT_PREFS, hasPreferences: false };
  try {
    return { ...normalizePreferences(JSON.parse(row.preferencesJson)), hasPreferences: true };
  } catch {
    return { ...DEFAULT_PREFS, hasPreferences: true };
  }
}

function listNotes(userId: string, workspaceId: string | null): any[] {
  const db = getDb();
  const scopeSql = workspaceId
    ? "notes.workspaceId = ?"
    : "notes.userId = ? AND notes.workspaceId IS NULL";
  const scopeParam = workspaceId || userId;

  return db.prepare(`
    SELECT
      notes.id,
      notes.userId,
      notes.notebookId,
      notes.workspaceId,
      notes.title,
      SUBSTR(COALESCE(notes.contentText, ''), 1, ${NOTE_PREVIEW_CHARS}) AS contentText,
      LENGTH(COALESCE(notes.contentText, '')) AS contentLength,
      notes.isPinned,
      CASE WHEN EXISTS(
        SELECT 1 FROM favorites f
        WHERE f.noteId = notes.id AND f.userId = ?
      ) THEN 1 ELSE 0 END AS isFavorite,
      notes.isLocked,
      notes.isArchived,
      notes.isTrashed,
      notes.version,
      notes.sortOrder,
      notes.createdAt,
      notes.updatedAt,
      notes.contentFormat,
      users.username AS creatorName
    FROM notes
    LEFT JOIN users ON users.id = notes.userId
    WHERE ${scopeSql} AND notes.isTrashed = 0
    ORDER BY notes.isPinned DESC, notes.sortOrder ASC, notes.updatedAt DESC, notes.id ASC
  `).all(userId, scopeParam) as any[];
}

function listNotebooks(userId: string, workspaceId: string | null): any[] {
  const db = getDb();
  if (!workspaceId) {
    return db.prepare(`
      WITH RECURSIVE nb_tree(ancestorId, descendantId) AS (
        SELECT id, id FROM notebooks
        WHERE userId = ? AND workspaceId IS NULL AND isDeleted = 0
        UNION ALL
        SELECT t.ancestorId, n.id
        FROM nb_tree t
        INNER JOIN notebooks n ON n.parentId = t.descendantId
        WHERE n.userId = ? AND n.workspaceId IS NULL AND n.isDeleted = 0
      )
      SELECT nb.*, COALESCE(nc.noteCount, 0) AS noteCount
      FROM notebooks nb
      LEFT JOIN (
        SELECT t.ancestorId AS notebookId, COUNT(notes.id) AS noteCount
        FROM nb_tree t
        INNER JOIN notes ON notes.notebookId = t.descendantId
        WHERE notes.userId = ? AND notes.isTrashed = 0 AND notes.workspaceId IS NULL
        GROUP BY t.ancestorId
      ) nc ON nb.id = nc.notebookId
      WHERE nb.userId = ? AND nb.workspaceId IS NULL AND nb.isDeleted = 0
      ORDER BY nb.sortOrder ASC
    `).all(userId, userId, userId, userId) as any[];
  }

  return db.prepare(`
    WITH RECURSIVE nb_tree(ancestorId, descendantId) AS (
      SELECT id, id FROM notebooks WHERE workspaceId = ? AND isDeleted = 0
      UNION ALL
      SELECT t.ancestorId, n.id
      FROM nb_tree t
      INNER JOIN notebooks n ON n.parentId = t.descendantId
      WHERE n.workspaceId = ? AND n.isDeleted = 0
    )
    SELECT nb.*, COALESCE(nc.noteCount, 0) AS noteCount
    FROM notebooks nb
    LEFT JOIN (
      SELECT t.ancestorId AS notebookId, COUNT(notes.id) AS noteCount
      FROM nb_tree t
      INNER JOIN notes ON notes.notebookId = t.descendantId
      WHERE notes.isTrashed = 0 AND notes.workspaceId = ?
      GROUP BY t.ancestorId
    ) nc ON nb.id = nc.notebookId
    WHERE nb.workspaceId = ? AND nb.isDeleted = 0
    ORDER BY nb.sortOrder ASC
  `).all(workspaceId, workspaceId, workspaceId, workspaceId) as any[];
}

function listSharedNotebooks(userId: string): any[] {
  const rows = getDb().prepare(`
    WITH shared AS (
      SELECT nb.id
      FROM notebook_members nm
      JOIN notebooks nb ON nb.id = nm.notebookId
      WHERE nm.userId = ?
        AND nm.status = 'active'
        AND nb.userId <> ?
        AND nb.isDeleted = 0
    ),
    nb_tree(ancestorId, descendantId) AS (
      SELECT id, id FROM notebooks
      WHERE id IN (SELECT id FROM shared) AND isDeleted = 0
      UNION ALL
      SELECT t.ancestorId, n.id
      FROM nb_tree t
      JOIN notebooks n ON n.parentId = t.descendantId
      WHERE n.isDeleted = 0
    )
    SELECT nb.*, COALESCE(nc.noteCount, 0) AS noteCount, nm.role AS myRole
    FROM notebooks nb
    JOIN notebook_members nm
      ON nm.notebookId = nb.id AND nm.userId = ? AND nm.status = 'active'
    LEFT JOIN (
      SELECT t.ancestorId AS notebookId, COUNT(notes.id) AS noteCount
      FROM nb_tree t
      JOIN notes ON notes.notebookId = t.descendantId
      WHERE notes.isTrashed = 0
      GROUP BY t.ancestorId
    ) nc ON nb.id = nc.notebookId
    WHERE nb.id IN (SELECT id FROM shared)
    ORDER BY nb.updatedAt DESC, nb.id ASC
  `).all(userId, userId, userId) as any[];

  return rows.map((row) => ({
    ...row,
    permission: notebookRoleToPermission(row.myRole),
  }));
}

/**
 * Android startup snapshot.
 *
 * The normal list endpoints remain unchanged for Web/Electron and for non-startup filters.
 * Android uses this endpoint only during the short cold-start window so one compact JSON
 * response replaces the duplicate notes/notebooks/tags/preferences/share-status requests.
 */
app.get("/", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const requestedWorkspace = c.req.query("workspaceId") || "personal";
  const workspaceId = normalizeWorkspaceId(requestedWorkspace);
  if (workspaceId && !getUserWorkspaceRole(workspaceId, userId)) {
    return c.json({ error: "无权访问该工作区" }, 403);
  }

  const db = getDb();
  const notes = listNotes(userId, workspaceId);
  const notebooks = listNotebooks(userId, workspaceId);
  const tags = tagsRepository.listByUser(userId, workspaceId, false);
  const sharedNoteIds = (db.prepare(
    "SELECT DISTINCT noteId FROM shares WHERE ownerId = ? AND isActive = 1 ORDER BY noteId ASC",
  ).all(userId) as Array<{ noteId: string }>).map((row) => row.noteId);

  c.header("Cache-Control", "private, no-store");
  c.header("X-Nowen-Mobile-Bootstrap", "1");
  return c.json({
    schemaVersion: 1,
    workspaceId: workspaceId || "personal",
    generatedAt: Date.now(),
    notes,
    notebooks,
    tags,
    sharedNoteIds,
    sharedNotebooks: listSharedNotebooks(userId),
    preferences: readPreferences(userId),
  });
});

export default app;
