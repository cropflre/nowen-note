import { Hono } from "hono";
import { getDb } from "../db/schema";

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

