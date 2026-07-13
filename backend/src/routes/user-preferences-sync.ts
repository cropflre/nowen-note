import { Hono } from "hono";
import { getDb } from "../db/schema";

type MarkdownViewMode = "source" | "preview" | "split";
type ReadingDensity = "cozy" | "compact";

export interface SyncedUserPreferences {
  noteTitleAsAppTitle: boolean;
  outlineDefaultOpen: boolean;
  lockOnOpen: boolean;
  showNotesInNotebookTree: boolean;
  readingDensity: ReadingDensity;
  showNoteListUpdatedTime: boolean;
  enableNoteTabs: boolean;
  markdownDefaultViewMode: MarkdownViewMode;
}

type PreferenceKey = keyof SyncedUserPreferences;
type PreferencePatch = Partial<SyncedUserPreferences>;
type FieldUpdatedAt = Partial<Record<PreferenceKey, string>>;

interface StoredPreferenceMeta {
  version: 2;
  revision: number;
  fieldUpdatedAt: FieldUpdatedAt;
}

interface StoredPreferenceDocument extends SyncedUserPreferences {
  __meta?: StoredPreferenceMeta;
}

interface PreferenceState {
  prefs: SyncedUserPreferences;
  hasPreferences: boolean;
  revision: number;
  fieldUpdatedAt: FieldUpdatedAt;
  updatedAt: string | null;
}

export const DEFAULT_SYNCED_USER_PREFERENCES: SyncedUserPreferences = {
  noteTitleAsAppTitle: false,
  outlineDefaultOpen: false,
  lockOnOpen: false,
  showNotesInNotebookTree: false,
  readingDensity: "cozy",
  showNoteListUpdatedTime: true,
  enableNoteTabs: false,
  markdownDefaultViewMode: "source",
};

const PREFERENCE_KEYS = Object.keys(DEFAULT_SYNCED_USER_PREFERENCES) as PreferenceKey[];
const PREFERENCE_KEY_SET = new Set<string>(PREFERENCE_KEYS);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePreferenceValue<K extends PreferenceKey>(
  key: K,
  value: unknown,
  fallback: SyncedUserPreferences[K],
): SyncedUserPreferences[K] {
  switch (key) {
    case "noteTitleAsAppTitle":
    case "outlineDefaultOpen":
    case "lockOnOpen":
    case "showNotesInNotebookTree":
    case "showNoteListUpdatedTime":
    case "enableNoteTabs":
      return (typeof value === "boolean" ? value : fallback) as SyncedUserPreferences[K];
    case "readingDensity":
      return (value === "cozy" || value === "compact" ? value : fallback) as SyncedUserPreferences[K];
    case "markdownDefaultViewMode":
      return (
        value === "source" || value === "preview" || value === "split"
          ? value
          : fallback
      ) as SyncedUserPreferences[K];
  }
}

export function normalizeSyncedUserPreferences(
  input: unknown,
  base: SyncedUserPreferences = DEFAULT_SYNCED_USER_PREFERENCES,
): SyncedUserPreferences {
  const raw = isObject(input) ? input : {};
  const next = { ...base };
  for (const key of PREFERENCE_KEYS) {
    next[key] = normalizePreferenceValue(key, raw[key], base[key]) as never;
  }
  return next;
}

function parseFieldUpdatedAt(value: unknown): FieldUpdatedAt {
  if (!isObject(value)) return {};
  const result: FieldUpdatedAt = {};
  for (const key of PREFERENCE_KEYS) {
    const timestamp = value[key];
    if (typeof timestamp === "string" && timestamp.length <= 64) {
      result[key] = timestamp;
    }
  }
  return result;
}

export function readPreferenceState(userId: string): PreferenceState {
  const row = getDb()
    .prepare("SELECT preferencesJson, updatedAt FROM user_preferences WHERE userId = ?")
    .get(userId) as { preferencesJson: string; updatedAt: string } | undefined;

  if (!row) {
    return {
      prefs: DEFAULT_SYNCED_USER_PREFERENCES,
      hasPreferences: false,
      revision: 0,
      fieldUpdatedAt: {},
      updatedAt: null,
    };
  }

  try {
    const parsed = JSON.parse(row.preferencesJson) as unknown;
    const raw = isObject(parsed) ? parsed : {};
    const meta = isObject(raw.__meta) ? raw.__meta : {};
    const revision = typeof meta.revision === "number" &&
      Number.isInteger(meta.revision) &&
      meta.revision > 0
      ? meta.revision
      : 1;

    return {
      prefs: normalizeSyncedUserPreferences(raw),
      hasPreferences: true,
      revision,
      fieldUpdatedAt: parseFieldUpdatedAt(meta.fieldUpdatedAt),
      updatedAt: row.updatedAt || null,
    };
  } catch {
    return {
      prefs: DEFAULT_SYNCED_USER_PREFERENCES,
      hasPreferences: true,
      revision: 1,
      fieldUpdatedAt: {},
      updatedAt: row.updatedAt || null,
    };
  }
}

function validatePatch(input: unknown): { patch: PreferencePatch; errors: string[] } {
  const raw = isObject(input) ? input : {};
  const patch: PreferencePatch = {};
  const errors: string[] = [];

  for (const key of PREFERENCE_KEYS) {
    if (!(key in raw)) continue;
    const current = DEFAULT_SYNCED_USER_PREFERENCES[key];
    const normalized = normalizePreferenceValue(key, raw[key], current);
    if (normalized === current && raw[key] !== current) {
      errors.push(`${key} 的值无效`);
      continue;
    }
    patch[key] = normalized as never;
  }

  return { patch, errors };
}

function serializeStoredPreferences(
  prefs: SyncedUserPreferences,
  revision: number,
  fieldUpdatedAt: FieldUpdatedAt,
): string {
  const document: StoredPreferenceDocument = {
    ...prefs,
    __meta: {
      version: 2,
      revision,
      fieldUpdatedAt,
    },
  };
  return JSON.stringify(document);
}

function responsePayload(userId: string, state: PreferenceState, conflict = false) {
  return {
    ...state.prefs,
    hasPreferences: state.hasPreferences,
    userId,
    revision: state.revision,
    fieldUpdatedAt: state.fieldUpdatedAt,
    updatedAt: state.updatedAt,
    conflict,
  };
}

async function writePreferences(c: any) {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const raw = isObject(body) ? body : {};
  const { patch, errors } = validatePatch(raw);
  if (errors.length > 0) {
    return c.json({ error: errors[0], code: "INVALID_USER_PREFERENCE" }, 400);
  }

  const patchKeys = Object.keys(patch) as PreferenceKey[];
  if (patchKeys.length === 0) {
    const unknownKeys = Object.keys(raw).filter((key) => !PREFERENCE_KEY_SET.has(key) && !key.startsWith("_"));
    return c.json({
      error: unknownKeys.length > 0
        ? "请求中没有可同步的账号级偏好字段"
        : "至少需要提供一个偏好字段",
      code: "EMPTY_USER_PREFERENCE_PATCH",
    }, 400);
  }

  const current = readPreferenceState(userId);
  const baseRevision = typeof raw._baseRevision === "number" && Number.isInteger(raw._baseRevision)
    ? raw._baseRevision
    : null;
  const migration = raw._migration === true;
  const conflict = baseRevision !== null && baseRevision !== current.revision;

  // 两台设备同时做首次迁移时，后到的设备不能用本地旧值覆盖已经建立的账号偏好。
  if (migration && current.hasPreferences) {
    return c.json(responsePayload(userId, current, true));
  }

  const nextPrefs = { ...current.prefs };
  const changedKeys: PreferenceKey[] = [];
  for (const key of patchKeys) {
    if (!current.hasPreferences || nextPrefs[key] !== patch[key]) {
      nextPrefs[key] = patch[key] as never;
      changedKeys.push(key);
    }
  }

  if (changedKeys.length === 0 && current.hasPreferences) {
    return c.json(responsePayload(userId, current, conflict));
  }

  const now = new Date().toISOString();
  const nextRevision = current.revision + 1;
  const fieldUpdatedAt = { ...current.fieldUpdatedAt };
  for (const key of changedKeys) fieldUpdatedAt[key] = now;

  getDb().prepare(`
    INSERT INTO user_preferences (userId, preferencesJson, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(userId) DO UPDATE SET
      preferencesJson = excluded.preferencesJson,
      updatedAt = excluded.updatedAt
  `).run(
    userId,
    serializeStoredPreferences(nextPrefs, nextRevision, fieldUpdatedAt),
    now,
  );

  return c.json(responsePayload(userId, {
    prefs: nextPrefs,
    hasPreferences: true,
    revision: nextRevision,
    fieldUpdatedAt,
    updatedAt: now,
  }, conflict));
}

const app = new Hono();

app.get("/", (c) => {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  return c.json(responsePayload(userId, readPreferenceState(userId)));
});

// PUT 保持旧客户端兼容；PATCH 为新客户端提供明确的增量语义。
app.put("/", writePreferences);
app.patch("/", writePreferences);

export default app;
