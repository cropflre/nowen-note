export const DEFAULT_NOTE_THEME_ID = "default";

const BUILT_IN_THEME_IDS = new Set(["default", "paper", "minimal", "eye-care"]);
const PLUGIN_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const LOCAL_THEME_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function normalizeNoteThemeId(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (BUILT_IN_THEME_IDS.has(normalized)) return normalized;
  if (normalized.length > 215) return null;
  const slash = normalized.indexOf("/");
  if (slash <= 0 || slash !== normalized.lastIndexOf("/")) return null;
  return PLUGIN_ID_RE.test(normalized.slice(0, slash))
    && LOCAL_THEME_ID_RE.test(normalized.slice(slash + 1))
    ? normalized
    : null;
}
