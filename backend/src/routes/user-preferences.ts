import { randomUUID } from "node:crypto";
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
  if (/\r\n\t/.test(icon) || Array.from(icon).length > MAX_NOTE_ICON_CODE_POINTS) {
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

// ---------------------------------------------------------------------------
// AI profiles
// ---------------------------------------------------------------------------
// The existing AI implementation reads ai_provider/ai_api_url/ai_api_key/ai_model
// from system_settings. Profiles are stored as one versioned JSON value and the
// active profile is mirrored back to those legacy keys. This keeps every existing
// AI entry point compatible while enabling fast switching and multiple saved
// providers without a database migration.

interface AIProfile {
  id: string;
  name: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

const AI_PROFILES_KEY = "ai_profiles_v1";
const AI_ACTIVE_PROFILE_KEY = "ai_active_profile_id";
const MAX_AI_PROFILES = 30;

function readSystemSetting(key: string): string {
  const row = getDb().prepare("SELECT value FROM system_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value || "";
}

function writeSystemSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO system_settings (key, value, updatedAt)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')
  `).run(key, value);
}

function normalizeProfile(input: unknown, base?: AIProfile): AIProfile {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const now = new Date().toISOString();
  const text = (value: unknown, fallback: string, max: number) =>
    typeof value === "string" ? value.trim().slice(0, max) : fallback;

  const apiUrl = text(raw.apiUrl, base?.apiUrl || "", 500).replace(/\/+$/, "");
  if (apiUrl) {
    const parsed = new URL(apiUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("AI API 地址必须使用 http 或 https");
    }
  }

  return {
    id: text(raw.id, base?.id || `ai-${randomUUID()}`, 100),
    name: text(raw.name, base?.name || "默认配置", 80) || "默认配置",
    provider: text(raw.provider, base?.provider || "openai", 40) || "openai",
    apiUrl,
    apiKey: text(raw.apiKey, base?.apiKey || "", 2000),
    model: text(raw.model, base?.model || "", 200),
    createdAt: base?.createdAt || now,
    updatedAt: now,
  };
}

function legacyProfile(): AIProfile {
  return normalizeProfile({
    name: "默认配置",
    provider: readSystemSetting("ai_provider") || "openai",
    apiUrl: readSystemSetting("ai_api_url") || "https://api.openai.com/v1",
    apiKey: readSystemSetting("ai_api_key"),
    model: readSystemSetting("ai_model") || "gpt-4o-mini",
  });
}

function parseStoredProfiles(): AIProfile[] {
  const raw = readSystemSetting(AI_PROFILES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice(0, MAX_AI_PROFILES)
      .map((item) => {
        try { return normalizeProfile(item, item as AIProfile); } catch { return null; }
      })
      .filter((item): item is AIProfile => !!item);
  } catch {
    return [];
  }
}

function saveAIProfiles(profiles: AIProfile[], activeProfileId: string): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO system_settings (key, value, updatedAt)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')
  `);
  db.transaction(() => {
    upsert.run(AI_PROFILES_KEY, JSON.stringify(profiles));
    upsert.run(AI_ACTIVE_PROFILE_KEY, activeProfileId);
  })();
}

function syncLegacyAISettings(profile: AIProfile): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO system_settings (key, value, updatedAt)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')
  `);
  db.transaction(() => {
    upsert.run("ai_provider", profile.provider);
    upsert.run("ai_api_url", profile.apiUrl);
    upsert.run("ai_api_key", profile.apiKey);
    upsert.run("ai_model", profile.model);
  })();
}

function ensureAIProfiles(): { profiles: AIProfile[]; activeProfileId: string } {
  let profiles = parseStoredProfiles();
  let activeProfileId = readSystemSetting(AI_ACTIVE_PROFILE_KEY);
  if (profiles.length === 0) {
    const initial = legacyProfile();
    profiles = [initial];
    activeProfileId = initial.id;
    saveAIProfiles(profiles, activeProfileId);
  }
  if (!profiles.some((profile) => profile.id === activeProfileId)) {
    activeProfileId = profiles[0].id;
    saveAIProfiles(profiles, activeProfileId);
  }
  return { profiles, activeProfileId };
}

function publicAIProfile(profile: AIProfile) {
  return {
    ...profile,
    apiKey: profile.apiKey ? `****${profile.apiKey.slice(-4)}` : "",
    apiKeySet: !!profile.apiKey,
  };
}

function resolveProfileKey(rawKey: unknown, currentKey: string): string {
  if (rawKey === undefined) return currentKey;
  if (typeof rawKey !== "string") return currentKey;
  if (rawKey.includes("****")) return currentKey;
  return rawKey.trim().slice(0, 2000);
}

function modelEndpoint(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, "");
  return /\/models$/i.test(base) ? base : `${base}/models`;
}

function extractModels(data: any): Array<{ id: string; name: string }> {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.models)
        ? data.models
        : [];

  const seen = new Set<string>();
  const models: Array<{ id: string; name: string }> = [];
  for (const row of rows) {
    const id = typeof row === "string"
      ? row
      : String(row?.id || row?.name || row?.model || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: String(row?.display_name || row?.displayName || row?.name || id) });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

const app = new Hono();

app.get("/ai-profiles", (c) => {
  const { profiles, activeProfileId } = ensureAIProfiles();
  return c.json({ profiles: profiles.map(publicAIProfile), activeProfileId });
});

app.post("/ai-profiles", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const state = ensureAIProfiles();
  if (state.profiles.length >= MAX_AI_PROFILES) {
    return c.json({ error: `最多保存 ${MAX_AI_PROFILES} 个 AI 配置` }, 400);
  }

  let profile: AIProfile;
  try {
    profile = normalizeProfile(body);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
  const profiles = [...state.profiles, profile];
  const activate = body.activate !== false;
  const activeProfileId = activate ? profile.id : state.activeProfileId;
  saveAIProfiles(profiles, activeProfileId);
  if (activate) syncLegacyAISettings(profile);
  return c.json({ profile: publicAIProfile(profile), activeProfileId }, 201);
});

app.post("/ai-profiles/discover-models", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const state = ensureAIProfiles();
  const stored = typeof body.profileId === "string"
    ? state.profiles.find((profile) => profile.id === body.profileId)
    : undefined;

  let profile: AIProfile;
  try {
    profile = normalizeProfile({
      ...stored,
      ...body,
      id: stored?.id,
      apiKey: resolveProfileKey(body.apiKey, stored?.apiKey || ""),
    }, stored);
  } catch (error) {
    return c.json({ error: (error as Error).message, models: [] }, 400);
  }

  if (!profile.apiUrl) return c.json({ error: "请先填写 AI API 地址", models: [] }, 400);
  if (profile.provider !== "ollama" && !profile.apiKey) {
    return c.json({ error: "请先填写 API Key", models: [] }, 400);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (profile.apiKey) {
    headers.Authorization = `Bearer ${profile.apiKey}`;
    if (profile.provider === "gemini") headers["x-goog-api-key"] = profile.apiKey;
  }

  const candidates = profile.provider === "ollama"
    ? [
        `${profile.apiUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")}/api/tags`,
        modelEndpoint(profile.apiUrl),
      ]
    : [modelEndpoint(profile.apiUrl)];

  const failures: string[] = [];
  for (const endpoint of Array.from(new Set(candidates))) {
    try {
      const response = await fetch(endpoint, {
        headers,
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        failures.push(`${response.status} ${detail.slice(0, 160)}`.trim());
        continue;
      }
      const data = await response.json();
      const models = extractModels(data);
      if (models.length > 0) {
        return c.json({ models, source: endpoint });
      }
      failures.push("接口返回成功，但没有可识别的模型列表");
    } catch (error) {
      failures.push((error as Error)?.message || "模型接口请求失败");
    }
  }

  return c.json({
    error: failures.filter(Boolean).join("；") || "无法获取模型列表",
    models: [],
  }, 502);
});

app.put("/ai-profiles/:profileId/activate", (c) => {
  const profileId = c.req.param("profileId");
  const state = ensureAIProfiles();
  const profile = state.profiles.find((item) => item.id === profileId);
  if (!profile) return c.json({ error: "AI 配置不存在" }, 404);
  saveAIProfiles(state.profiles, profile.id);
  syncLegacyAISettings(profile);
  return c.json({ profile: publicAIProfile(profile), activeProfileId: profile.id });
});

app.put("/ai-profiles/:profileId", async (c) => {
  const profileId = c.req.param("profileId");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const state = ensureAIProfiles();
  const index = state.profiles.findIndex((item) => item.id === profileId);
  if (index < 0) return c.json({ error: "AI 配置不存在" }, 404);

  const current = state.profiles[index];
  let updated: AIProfile;
  try {
    updated = normalizeProfile({
      ...body,
      id: current.id,
      apiKey: resolveProfileKey(body.apiKey, current.apiKey),
    }, current);
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }

  const profiles = [...state.profiles];
  profiles[index] = updated;
  saveAIProfiles(profiles, state.activeProfileId);
  if (state.activeProfileId === updated.id) syncLegacyAISettings(updated);
  return c.json({ profile: publicAIProfile(updated), activeProfileId: state.activeProfileId });
});

app.delete("/ai-profiles/:profileId", (c) => {
  const profileId = c.req.param("profileId");
  const state = ensureAIProfiles();
  if (state.profiles.length <= 1) {
    return c.json({ error: "至少需要保留一个 AI 配置" }, 400);
  }
  if (!state.profiles.some((item) => item.id === profileId)) {
    return c.json({ error: "AI 配置不存在" }, 404);
  }

  const profiles = state.profiles.filter((item) => item.id !== profileId);
  const activeProfileId = state.activeProfileId === profileId ? profiles[0].id : state.activeProfileId;
  saveAIProfiles(profiles, activeProfileId);
  if (state.activeProfileId === profileId) syncLegacyAISettings(profiles[0]);
  return c.json({ success: true, activeProfileId });
});

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
