export type ReadingDensity = "cozy" | "compact";
export type MarkdownViewMode = "source" | "preview" | "split";
export type EditorMode = "md" | "tiptap";
export type CodeBlockThemeId =
  | "github-dark"
  | "github-light"
  | "dracula"
  | "monokai"
  | "solarized-light"
  | "one-dark"
  | "nord";

export interface UserPreferences {
  noteTitleAsAppTitle: boolean;
  outlineDefaultOpen: boolean;
  lockOnOpen: boolean;
  showNotesInNotebookTree: boolean;
  showSpaceActions: boolean;
  readingDensity: ReadingDensity;
  showNoteListUpdatedTime: boolean;
  enableNoteTabs: boolean;
  markdownDefaultViewMode: MarkdownViewMode;
  defaultEditorMode: EditorMode;
  codeBlockTheme: CodeBlockThemeId;
  noteListTitleOnly: boolean;
}

export type UserPreferencePatch = Partial<UserPreferences>;

export interface UserPreferenceCache {
  version: 2;
  userId: string;
  prefs: UserPreferences;
  revision: number;
  pending: UserPreferencePatch;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  noteTitleAsAppTitle: false,
  outlineDefaultOpen: false,
  lockOnOpen: false,
  showNotesInNotebookTree: false,
  showSpaceActions: true,
  readingDensity: "cozy",
  showNoteListUpdatedTime: true,
  enableNoteTabs: false,
  markdownDefaultViewMode: "source",
  defaultEditorMode: "tiptap",
  codeBlockTheme: "github-dark",
  noteListTitleOnly: false,
};

export const LEGACY_USER_PREFERENCES_KEY = "nowen.user-prefs.v1";
export const LEGACY_USER_PREFERENCES_OWNER_KEY = "nowen.user-prefs.v1.migrated-user";
export const LEGACY_EDITOR_MODE_KEY = "nowen.editor_mode";
export const LEGACY_CODE_BLOCK_THEME_KEY = "nowen.codeBlockTheme";
export const LEGACY_NOTE_LIST_TITLE_ONLY_KEY = "nowen.noteList.titleOnly";
const ACCOUNT_CACHE_PREFIX = "nowen.user-prefs.v2:";
const LEGACY_SHOW_TIME_KEY = "nowen.noteList.showTime";

const PREFERENCE_KEYS = Object.keys(DEFAULT_USER_PREFERENCES) as Array<keyof UserPreferences>;
const CODE_BLOCK_THEMES = new Set<CodeBlockThemeId>([
  "github-dark",
  "github-light",
  "dracula",
  "monokai",
  "solarized-light",
  "one-dark",
  "nord",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeUserPreferences(
  input: unknown,
  fallback: UserPreferences = DEFAULT_USER_PREFERENCES,
  legacyShowTime?: boolean,
): UserPreferences {
  const raw = isObject(input) ? input as Partial<UserPreferences> : {};
  return {
    noteTitleAsAppTitle: typeof raw.noteTitleAsAppTitle === "boolean"
      ? raw.noteTitleAsAppTitle
      : fallback.noteTitleAsAppTitle,
    outlineDefaultOpen: typeof raw.outlineDefaultOpen === "boolean"
      ? raw.outlineDefaultOpen
      : fallback.outlineDefaultOpen,
    lockOnOpen: typeof raw.lockOnOpen === "boolean"
      ? raw.lockOnOpen
      : fallback.lockOnOpen,
    showNotesInNotebookTree: typeof raw.showNotesInNotebookTree === "boolean"
      ? raw.showNotesInNotebookTree
      : fallback.showNotesInNotebookTree,
    showSpaceActions: typeof raw.showSpaceActions === "boolean"
      ? raw.showSpaceActions
      : fallback.showSpaceActions,
    readingDensity: raw.readingDensity === "compact" || raw.readingDensity === "cozy"
      ? raw.readingDensity
      : fallback.readingDensity,
    showNoteListUpdatedTime: typeof raw.showNoteListUpdatedTime === "boolean"
      ? raw.showNoteListUpdatedTime
      : legacyShowTime ?? fallback.showNoteListUpdatedTime,
    enableNoteTabs: typeof raw.enableNoteTabs === "boolean"
      ? raw.enableNoteTabs
      : fallback.enableNoteTabs,
    markdownDefaultViewMode:
      raw.markdownDefaultViewMode === "source" ||
      raw.markdownDefaultViewMode === "preview" ||
      raw.markdownDefaultViewMode === "split"
        ? raw.markdownDefaultViewMode
        : fallback.markdownDefaultViewMode,
    defaultEditorMode: raw.defaultEditorMode === "md" || raw.defaultEditorMode === "tiptap"
      ? raw.defaultEditorMode
      : fallback.defaultEditorMode,
    codeBlockTheme:
      typeof raw.codeBlockTheme === "string" && CODE_BLOCK_THEMES.has(raw.codeBlockTheme as CodeBlockThemeId)
        ? raw.codeBlockTheme as CodeBlockThemeId
        : fallback.codeBlockTheme,
    noteListTitleOnly: typeof raw.noteListTitleOnly === "boolean"
      ? raw.noteListTitleOnly
      : fallback.noteListTitleOnly,
  };
}

export function sanitizeUserPreferencePatch(input: unknown): UserPreferencePatch {
  if (!isObject(input)) return {};
  const normalized = normalizeUserPreferences(input);
  const patch: UserPreferencePatch = {};
  for (const key of PREFERENCE_KEYS) {
    if (key in input) patch[key] = normalized[key] as never;
  }
  return patch;
}

export function accountPreferenceStorageKey(userId: string): string {
  return `${ACCOUNT_CACHE_PREFIX}${encodeURIComponent(userId)}`;
}

export function decodeUserIdFromToken(token: string | null | undefined): string | null {
  if (!token) return null;
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return null;
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const decoded = globalThis.atob(padded);
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { userId?: unknown };
    return typeof payload.userId === "string" && payload.userId.trim()
      ? payload.userId.trim()
      : null;
  } catch {
    return null;
  }
}

export function readAccountPreferenceCache(
  storage: StorageLike,
  userId: string,
): UserPreferenceCache | null {
  try {
    const raw = storage.getItem(accountPreferenceStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || parsed.version !== 2 || parsed.userId !== userId) return null;
    const revision = typeof parsed.revision === "number" &&
      Number.isInteger(parsed.revision) &&
      parsed.revision >= 0
      ? parsed.revision
      : 0;
    return {
      version: 2,
      userId,
      prefs: normalizeUserPreferences(parsed.prefs),
      revision,
      pending: sanitizeUserPreferencePatch(parsed.pending),
    };
  } catch {
    return null;
  }
}

export function writeAccountPreferenceCache(
  storage: StorageLike,
  cache: UserPreferenceCache,
): void {
  try {
    storage.setItem(accountPreferenceStorageKey(cache.userId), JSON.stringify({
      version: 2,
      userId: cache.userId,
      prefs: normalizeUserPreferences(cache.prefs),
      revision: Math.max(0, Math.trunc(cache.revision || 0)),
      pending: sanitizeUserPreferencePatch(cache.pending),
    }));
  } catch {
    // 隐私模式、配额不足或只读存储时保留内存态。
  }
}

export function claimLegacyUserPreferences(
  storage: StorageLike,
  userId: string,
): UserPreferences | null {
  try {
    const owner = storage.getItem(LEGACY_USER_PREFERENCES_OWNER_KEY);
    if (owner && owner !== userId) return null;

    const raw = storage.getItem(LEGACY_USER_PREFERENCES_KEY);
    const legacyShowTimeRaw = storage.getItem(LEGACY_SHOW_TIME_KEY);
    const editorMode = storage.getItem(LEGACY_EDITOR_MODE_KEY);
    const codeBlockTheme = storage.getItem(LEGACY_CODE_BLOCK_THEME_KEY);
    const titleOnly = storage.getItem(LEGACY_NOTE_LIST_TITLE_ONLY_KEY);
    if (!raw && legacyShowTimeRaw === null && editorMode === null && codeBlockTheme === null && titleOnly === null) {
      return null;
    }

    let parsed: unknown = {};
    if (raw) {
      try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    }
    const legacyShowTime = legacyShowTimeRaw === null
      ? undefined
      : legacyShowTimeRaw === "true";
    const legacy = isObject(parsed) ? { ...parsed } : {};
    if (editorMode === "md" || editorMode === "tiptap") legacy.defaultEditorMode = editorMode;
    if (codeBlockTheme && CODE_BLOCK_THEMES.has(codeBlockTheme as CodeBlockThemeId)) {
      legacy.codeBlockTheme = codeBlockTheme;
    }
    if (titleOnly !== null) legacy.noteListTitleOnly = titleOnly === "true";

    // 第一个登录并发现旧缓存的账号获得迁移所有权，避免之后切换账号时重复上传。
    storage.setItem(LEGACY_USER_PREFERENCES_OWNER_KEY, userId);
    return normalizeUserPreferences(legacy, DEFAULT_USER_PREFERENCES, legacyShowTime);
  } catch {
    return null;
  }
}

export function mergePendingPreferences(
  remote: UserPreferences,
  pending: UserPreferencePatch,
): UserPreferences {
  return normalizeUserPreferences({ ...remote, ...pending }, remote);
}
