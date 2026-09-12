import type { PluginContributionRecord, PluginNoteThemeTokens } from "@/lib/pluginApi";
import {
  NOTE_THEMES,
  isNoteThemeId,
  resolveNoteThemeTokens,
  type NoteThemeMode,
  type NoteThemeTokens,
} from "@/lib/noteTheme";

const PLUGIN_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const LOCAL_THEME_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const COLOR_RE = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const TOKEN_KEYS = new Set<keyof NoteThemeTokens>([
  "surface", "text", "heading", "muted", "border", "accent", "accentHover",
  "inlineCodeBackground", "inlineCodeText", "preBackground", "preText", "quoteBorder",
  "quoteText", "softBackground", "tableStripe", "markBackground", "selection",
  "contentMaxWidth", "lineHeight",
]);
const COLOR_KEYS = new Set<keyof NoteThemeTokens>([
  "surface", "text", "heading", "muted", "border", "accent", "accentHover",
  "inlineCodeBackground", "inlineCodeText", "preBackground", "preText", "quoteBorder",
  "quoteText", "softBackground", "tableStripe", "markBackground", "selection",
]);

export interface RegisteredPluginNoteTheme {
  id: string;
  pluginId: string;
  localId: string;
  name: string;
  description?: string;
  modes: { light: Partial<NoteThemeTokens>; dark?: Partial<NoteThemeTokens> };
}

export interface AvailableNoteTheme {
  id: string;
  name: string;
  description: string;
  source: "built-in" | "plugin";
  pluginId?: string;
}

const themes = new Map<string, RegisteredPluginNoteTheme>();
const listeners = new Set<() => void>();

export function makePluginNoteThemeId(pluginId: string, localId: string): string {
  return `${pluginId.trim().toLowerCase()}/${localId.trim().toLowerCase()}`;
}

export function isNamespacedNoteThemeId(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 215) return false;
  const slash = value.indexOf("/");
  return slash > 0
    && slash === value.lastIndexOf("/")
    && PLUGIN_ID_RE.test(value.slice(0, slash))
    && LOCAL_THEME_ID_RE.test(value.slice(slash + 1));
}

export function isStoredNoteThemeId(value: unknown): value is string {
  return isNoteThemeId(value) || isNamespacedNoteThemeId(value);
}

function sanitizeTokens(input: PluginNoteThemeTokens): Partial<NoteThemeTokens> | null {
  const output: Partial<NoteThemeTokens> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey as keyof NoteThemeTokens;
    if (!TOKEN_KEYS.has(key) || typeof rawValue !== "string") return null;
    if (COLOR_KEYS.has(key) && !COLOR_RE.test(rawValue)) return null;
    if (key === "contentMaxWidth") {
      const match = /^(\d{3,4})px$/.exec(rawValue);
      if (!match || Number(match[1]) < 480 || Number(match[1]) > 1200) return null;
    }
    if (key === "lineHeight") {
      const value = Number(rawValue);
      if (!/^\d(?:\.\d{1,2})?$/.test(rawValue) || value < 1.2 || value > 2.2) return null;
    }
    output[key] = rawValue;
  }
  return Object.keys(output).length > 0 ? output : null;
}

export function replacePluginNoteThemes(records: PluginContributionRecord[]): number {
  const next = new Map<string, RegisteredPluginNoteTheme>();
  for (const record of records) {
    const pluginId = typeof record.pluginId === "string" ? record.pluginId.toLowerCase() : "";
    if (!PLUGIN_ID_RE.test(pluginId) || !Array.isArray(record.noteThemes)) continue;
    for (const contribution of record.noteThemes) {
      const localId = contribution?.id?.toLowerCase();
      if (!LOCAL_THEME_ID_RE.test(localId) || typeof contribution.name !== "string") continue;
      const light = sanitizeTokens(contribution.modes?.light || {});
      const dark = contribution.modes?.dark ? sanitizeTokens(contribution.modes.dark) : undefined;
      if (!light || (contribution.modes?.dark && !dark)) continue;
      const id = makePluginNoteThemeId(pluginId, localId);
      next.set(id, {
        id,
        pluginId,
        localId,
        name: contribution.name,
        description: contribution.description,
        modes: { light, ...(dark ? { dark } : {}) },
      });
    }
  }
  themes.clear();
  for (const [id, theme] of next) themes.set(id, theme);
  for (const listener of listeners) listener();
  return themes.size;
}

export function subscribePluginNoteThemes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function listAvailableNoteThemes(locale = "zh"): AvailableNoteTheme[] {
  const builtIns = NOTE_THEMES.map((theme) => ({
    id: theme.id,
    name: locale.startsWith("zh") ? theme.name.zh : theme.name.en,
    description: locale.startsWith("zh") ? theme.description.zh : theme.description.en,
    source: "built-in" as const,
  }));
  const plugins = [...themes.values()].map((theme) => ({
    id: theme.id,
    name: theme.name,
    description: theme.description || "",
    source: "plugin" as const,
    pluginId: theme.pluginId,
  }));
  return [...builtIns, ...plugins];
}

export function resolveRegisteredNoteTheme(
  themeId: string,
  mode: NoteThemeMode,
): { id: string; available: boolean; tokens: NoteThemeTokens } {
  if (isNoteThemeId(themeId)) {
    return { id: themeId, available: true, tokens: resolveNoteThemeTokens(themeId, mode) };
  }
  const pluginTheme = themes.get(themeId);
  if (!pluginTheme) {
    return { id: "default", available: false, tokens: resolveNoteThemeTokens("default", mode) };
  }
  const overrides = mode === "dark" ? pluginTheme.modes.dark : pluginTheme.modes.light;
  return {
    id: pluginTheme.id,
    available: true,
    tokens: { ...resolveNoteThemeTokens("default", mode), ...(overrides || {}) },
  };
}
