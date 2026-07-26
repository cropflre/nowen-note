import type { ShortcutChord, ShortcutPlatform } from "./shortcuts/types";

export const SHORTCUT_OVERRIDES_STORAGE_KEY = "nowen-shortcut-overrides:v1";
export const SHORTCUT_OVERRIDES_CHANGED_EVENT = "nowen:shortcut-overrides-changed";

const PLATFORMS: readonly ShortcutPlatform[] = ["macos", "windows", "linux"];
const MODIFIER_TOKENS = new Set(["Mod", "Alt", "Shift"]);
const NAMED_KEYS = new Set([
  "Enter", "Escape", "Backspace", "Delete", "Tab", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End",
  "PageUp", "PageDown", "F1", "F2", "F3", "F4", "F5", "F6",
  "F7", "F8", "F9", "F10", "F11", "F12",
]);

export interface ShortcutOverrideDocument {
  version: 1;
  platforms: Partial<Record<ShortcutPlatform, Record<string, ShortcutChord[]>>>;
}

export interface ShortcutImportOptions {
  validCommandIds: ReadonlySet<string>;
  customizableCommandIds: ReadonlySet<string>;
  validateChord: (chord: ShortcutChord, platform: ShortcutPlatform, commandId: string) => string | null;
}

function emptyDocument(): ShortcutOverrideDocument {
  return { version: 1, platforms: {} };
}

function normalizeKeyToken(value: string): string | null {
  if (MODIFIER_TOKENS.has(value)) return value;
  if (NAMED_KEYS.has(value)) return value;
  if (value.length === 1 && !/\s/.test(value)) return value.toUpperCase();
  return null;
}

function sanitizeChord(value: unknown): ShortcutChord | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) return null;
  const tokens: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const token = normalizeKeyToken(item);
    if (!token || tokens.includes(token)) return null;
    tokens.push(token);
  }
  const primaryKeys = tokens.filter((token) => !MODIFIER_TOKENS.has(token));
  if (primaryKeys.length !== 1) return null;
  return tokens;
}

function sanitizeDocument(value: unknown): ShortcutOverrideDocument {
  if (!value || typeof value !== "object") return emptyDocument();
  const candidate = value as { version?: unknown; platforms?: unknown };
  if (candidate.version !== 1 || !candidate.platforms || typeof candidate.platforms !== "object") {
    return emptyDocument();
  }

  const document: ShortcutOverrideDocument = emptyDocument();
  for (const platform of PLATFORMS) {
    const rawPlatform = (candidate.platforms as Record<string, unknown>)[platform];
    if (!rawPlatform || typeof rawPlatform !== "object" || Array.isArray(rawPlatform)) continue;
    const commands: Record<string, ShortcutChord[]> = {};
    for (const [commandId, rawChords] of Object.entries(rawPlatform as Record<string, unknown>)) {
      if (!Array.isArray(rawChords)) continue;
      const chords = rawChords.map(sanitizeChord);
      if (chords.some((chord) => chord == null)) continue;
      commands[commandId] = chords as ShortcutChord[];
    }
    if (Object.keys(commands).length > 0) document.platforms[platform] = commands;
  }
  return document;
}

function readDocument(): ShortcutOverrideDocument {
  if (typeof localStorage === "undefined") return emptyDocument();
  try {
    const raw = localStorage.getItem(SHORTCUT_OVERRIDES_STORAGE_KEY);
    return raw ? sanitizeDocument(JSON.parse(raw)) : emptyDocument();
  } catch {
    return emptyDocument();
  }
}

function emitChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SHORTCUT_OVERRIDES_CHANGED_EVENT));
  }
}

function writeDocument(document: ShortcutOverrideDocument): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SHORTCUT_OVERRIDES_STORAGE_KEY, JSON.stringify(document));
  emitChanged();
}

export function getShortcutOverride(
  commandId: string,
  platform: ShortcutPlatform,
): readonly ShortcutChord[] | undefined {
  return readDocument().platforms[platform]?.[commandId];
}

export function hasShortcutOverride(commandId: string, platform: ShortcutPlatform): boolean {
  return getShortcutOverride(commandId, platform) !== undefined;
}

export function setShortcutOverride(
  commandId: string,
  platform: ShortcutPlatform,
  chords: readonly ShortcutChord[],
): void {
  const document = readDocument();
  const platformOverrides = { ...(document.platforms[platform] ?? {}) };
  platformOverrides[commandId] = chords.map((chord) => [...chord]);
  document.platforms[platform] = platformOverrides;
  writeDocument(document);
}

export function resetShortcutOverride(commandId: string, platform: ShortcutPlatform): void {
  const document = readDocument();
  const platformOverrides = { ...(document.platforms[platform] ?? {}) };
  if (!(commandId in platformOverrides)) return;
  delete platformOverrides[commandId];
  if (Object.keys(platformOverrides).length > 0) document.platforms[platform] = platformOverrides;
  else delete document.platforms[platform];
  writeDocument(document);
}

export function resetAllShortcutOverrides(platform?: ShortcutPlatform): void {
  if (!platform) {
    writeDocument(emptyDocument());
    return;
  }
  const document = readDocument();
  if (!document.platforms[platform]) return;
  delete document.platforms[platform];
  writeDocument(document);
}

export function exportShortcutOverrides(): string {
  return JSON.stringify(readDocument(), null, 2);
}

export function importShortcutOverrides(raw: string, options: ShortcutImportOptions): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("快捷键配置不是有效的 JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("快捷键配置格式无效");
  const candidate = parsed as { version?: unknown; platforms?: unknown };
  if (candidate.version !== 1) throw new Error("不支持的快捷键配置版本");
  if (!candidate.platforms || typeof candidate.platforms !== "object" || Array.isArray(candidate.platforms)) {
    throw new Error("快捷键配置缺少 platforms");
  }

  const next = emptyDocument();
  let applied = 0;
  for (const [platformKey, rawPlatform] of Object.entries(candidate.platforms as Record<string, unknown>)) {
    if (!PLATFORMS.includes(platformKey as ShortcutPlatform)) {
      throw new Error(`未知平台：${platformKey}`);
    }
    if (!rawPlatform || typeof rawPlatform !== "object" || Array.isArray(rawPlatform)) {
      throw new Error(`${platformKey} 平台配置格式无效`);
    }
    const platform = platformKey as ShortcutPlatform;
    const platformOverrides: Record<string, ShortcutChord[]> = {};
    for (const [commandId, rawChords] of Object.entries(rawPlatform as Record<string, unknown>)) {
      if (!options.validCommandIds.has(commandId)) throw new Error(`未知命令：${commandId}`);
      if (!options.customizableCommandIds.has(commandId)) throw new Error(`命令不可自定义：${commandId}`);
      if (!Array.isArray(rawChords) || rawChords.length > 1) {
        throw new Error(`${commandId} 目前只支持一个组合键`);
      }
      const chords: ShortcutChord[] = [];
      for (const rawChord of rawChords) {
        const chord = sanitizeChord(rawChord);
        if (!chord) throw new Error(`${commandId} 包含无效组合键`);
        const invalidReason = options.validateChord(chord, platform, commandId);
        if (invalidReason) throw new Error(`${commandId}：${invalidReason}`);
        chords.push(chord);
      }
      platformOverrides[commandId] = chords;
      applied += 1;
    }
    if (Object.keys(platformOverrides).length > 0) next.platforms[platform] = platformOverrides;
  }
  writeDocument(next);
  return applied;
}

function normalizeEventKey(key: string): string | null {
  if (key === " ") return "Space";
  if (key === "Esc") return "Escape";
  if (NAMED_KEYS.has(key)) return key;
  if (key.length === 1 && !/\s/.test(key)) return key.toUpperCase();
  return null;
}

export function shortcutChordFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">,
  platform: ShortcutPlatform,
): ShortcutChord | null {
  if (event.isComposing) return null;
  const key = normalizeEventKey(event.key);
  if (!key || ["Meta", "Control", "Alt", "Shift"].includes(event.key)) return null;
  const tokens: string[] = [];
  const usesMod = platform === "macos" ? event.metaKey : event.ctrlKey;
  if (usesMod) tokens.push("Mod");
  if (event.altKey) tokens.push("Alt");
  if (event.shiftKey) tokens.push("Shift");
  tokens.push(key);
  return tokens;
}
