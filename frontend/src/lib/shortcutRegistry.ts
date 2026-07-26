import { getShortcutOverride } from "./shortcutOverrides";
import { MOD, SHORTCUT_CATEGORY_LABELS, SHORTCUT_COMMANDS } from "./shortcuts/commands";
import type {
  ShortcutChord,
  ShortcutCommand,
  ShortcutConflict,
  ShortcutPlatform,
  ShortcutScope,
  ShortcutSurface,
} from "./shortcuts/types";

export { SHORTCUT_CATEGORY_LABELS, SHORTCUT_COMMANDS };
export type {
  ShortcutCategory,
  ShortcutChord,
  ShortcutCommand,
  ShortcutConflict,
  ShortcutPlatform,
  ShortcutScope,
  ShortcutSurface,
} from "./shortcuts/types";

const COMMAND_BY_ID = new Map(SHORTCUT_COMMANDS.map((command) => [command.id, command]));
const TOOLTIP_ALIAS_TO_ID = new Map<string, string>();
const MODIFIER_TOKENS = [MOD, "Alt", "Shift"];
const SHORTCUT_SUFFIX = /\s*\((?:Ctrl|Cmd|Command|⌘|Alt|Option|⌥|Shift|⇧)[^)]*\)\s*$/i;

function normalizeLabel(value: string): string {
  return value.replace(SHORTCUT_SUFFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}

for (const command of SHORTCUT_COMMANDS) {
  for (const alias of command.tooltipAliases ?? []) {
    TOOLTIP_ALIAS_TO_ID.set(normalizeLabel(alias), command.id);
  }
}

export function getShortcutCommand(commandId: string): ShortcutCommand | undefined {
  return COMMAND_BY_ID.get(commandId);
}

export function detectShortcutPlatform(input?: { platform?: string; userAgent?: string }): ShortcutPlatform {
  const platform = (input?.platform ?? (typeof navigator !== "undefined" ? navigator.platform : "")).toLowerCase();
  const userAgent = (input?.userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "")).toLowerCase();
  if (platform.includes("mac") || userAgent.includes("mac os")) return "macos";
  if (platform.includes("win") || userAgent.includes("windows")) return "windows";
  return "linux";
}

export function detectShortcutSurface(userAgent?: string): ShortcutSurface {
  const ua = (userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "")).toLowerCase();
  if (ua.includes("android") || ua.includes("iphone") || ua.includes("ipad")) return "android";
  return ua.includes("electron") ? "desktop" : "web";
}

function platformToken(token: string, platform: ShortcutPlatform): string {
  if (token === MOD) return platform === "macos" ? "⌘" : "Ctrl";
  if (token === "Alt") return platform === "macos" ? "⌥" : "Alt";
  if (token === "Shift") return platform === "macos" ? "⇧" : "Shift";
  if (token === "Enter") return platform === "macos" ? "↩" : "Enter";
  if (token === "Backspace") return platform === "macos" ? "⌫" : "Backspace";
  if (token === "Escape") return "Esc";
  return token.length === 1 ? token.toUpperCase() : token;
}

function portableToken(token: string): string {
  if (token === MOD) return "Ctrl/Cmd";
  if (token === "Escape") return "Esc";
  return token.length === 1 ? token.toUpperCase() : token;
}

export function formatShortcutChord(
  chord: ShortcutChord,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  return chord.map((token) => platformToken(token, platform)).join(platform === "macos" ? "" : "+");
}

export function formatPortableShortcutChord(chord: ShortcutChord): string {
  return chord.map(portableToken).join(" + ");
}

function getRawCommandChords(
  command: ShortcutCommand,
  platform: ShortcutPlatform,
  surface: ShortcutSurface,
): readonly ShortcutChord[] {
  if (!command.availableIn.includes(surface)) return [];
  const surfaceOverride = command.surfaceKeys?.[surface]?.[platform];
  if (surfaceOverride !== undefined) return surfaceOverride;
  return command.defaultKeys[platform] ?? [];
}

function getCommandChords(
  command: ShortcutCommand,
  platform: ShortcutPlatform,
  surface: ShortcutSurface,
): readonly ShortcutChord[] {
  if (!command.availableIn.includes(surface)) return [];
  if (command.customizable) {
    const override = getShortcutOverride(command.id, platform);
    if (override !== undefined) return override;
  }
  return getRawCommandChords(command, platform, surface);
}

export function getDefaultShortcutChords(
  commandId: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  surface: ShortcutSurface = detectShortcutSurface(),
): readonly ShortcutChord[] {
  const command = getShortcutCommand(commandId);
  return command ? getRawCommandChords(command, platform, surface) : [];
}

export function getShortcutChords(
  commandId: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  surface: ShortcutSurface = detectShortcutSurface(),
): readonly ShortcutChord[] {
  const command = getShortcutCommand(commandId);
  return command ? getCommandChords(command, platform, surface) : [];
}

export function formatShortcutForCommand(
  commandId: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  surface: ShortcutSurface = detectShortcutSurface(),
): string {
  const first = getShortcutChords(commandId, platform, surface)[0];
  return first ? formatShortcutChord(first, platform) : "";
}

export function formatPortableShortcutForCommand(
  commandId: string,
  surface: ShortcutSurface = "web",
): string {
  const first = getShortcutChords(commandId, "windows", surface)[0];
  return first ? formatPortableShortcutChord(first) : "";
}

function eventKeyToken(event: Pick<KeyboardEvent, "key">): string {
  if (event.key === "?") return "/";
  if (event.key === " ") return "Space";
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

export function shortcutChordMatchesEvent(
  chord: ShortcutChord,
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): boolean {
  const expectedKey = chord.find((token) => !MODIFIER_TOKENS.includes(token));
  return event.metaKey === (chord.includes(MOD) && platform === "macos")
    && event.ctrlKey === (chord.includes(MOD) && platform !== "macos")
    && event.altKey === chord.includes("Alt")
    && event.shiftKey === chord.includes("Shift")
    && !!expectedKey
    && eventKeyToken(event).toLowerCase() === expectedKey.toLowerCase();
}

export function shortcutMatchesEvent(
  commandId: string,
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  surface: ShortcutSurface = detectShortcutSurface(),
): boolean {
  return getShortcutChords(commandId, platform, surface)
    .some((chord) => shortcutChordMatchesEvent(chord, event, platform));
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || target.isContentEditable;
}

function isEditorShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || !!target.closest(".ProseMirror, .cm-editor, [data-editor-root]");
}

export function isShortcutAllowedInTarget(commandId: string, target: EventTarget | null): boolean {
  const scope = getShortcutCommand(commandId)?.scope;
  if (!scope) return false;
  if (scope === "global" || scope === "input-safe") return true;
  if (scope === "editor") return isEditorShortcutTarget(target);
  return !isEditableShortcutTarget(target);
}

function normalizedChordKey(chord: ShortcutChord, platform: ShortcutPlatform): string {
  return chord
    .map((token) => token === MOD ? (platform === "macos" ? "Meta" : "Ctrl") : token)
    .map((token) => token.toLowerCase())
    .sort()
    .join("+");
}

function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  if (a === b) return true;
  if (a === "input-safe" || b === "input-safe") return true;
  return a === "global" || b === "global";
}

export function validateShortcutChord(
  chord: ShortcutChord,
  _platform: ShortcutPlatform,
  _surface: ShortcutSurface,
  _commandId?: string,
): string | null {
  const primary = chord.find((token) => !MODIFIER_TOKENS.includes(token));
  if (!primary) return "组合键缺少主按键";
  if (!chord.includes(MOD) && !chord.includes("Alt")) {
    return "快捷键必须包含 Ctrl/Cmd 或 Alt，避免影响普通输入和 IME";
  }
  if (primary === "F5" || primary === "F12") return "该按键由浏览器或开发者工具保留";
  if (chord.includes("Alt") && primary === "F4") return "Alt+F4 为系统关闭窗口快捷键";
  if (chord.includes(MOD) && ["A", "C", "V", "X", "Z"].includes(primary)) {
    return "复制、粘贴、剪切、全选和撤销等平台基础快捷键不可覆盖";
  }
  if (chord.includes(MOD) && chord.includes("Shift") && ["I", "J", "C"].includes(primary)) {
    return "该组合键通常由浏览器开发者工具保留";
  }
  if (chord.includes(MOD) && ["R", "W", "Q"].includes(primary)) {
    return "刷新、关闭标签页或退出应用的系统快捷键不可覆盖";
  }
  return null;
}

export interface ShortcutCandidateConflict {
  surface: ShortcutSurface;
  commandId: string;
  customizable: boolean;
}

export function findShortcutConflictsForCandidate(
  commandId: string,
  chord: ShortcutChord,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): ShortcutCandidateConflict[] {
  const source = getShortcutCommand(commandId);
  if (!source) return [];
  const candidateKey = normalizedChordKey(chord, platform);
  const conflicts: ShortcutCandidateConflict[] = [];
  for (const surface of ["web", "desktop"] as const) {
    if (!source.availableIn.includes(surface)) continue;
    for (const command of SHORTCUT_COMMANDS) {
      if (command.id === commandId || !command.availableIn.includes(surface)) continue;
      if (!scopesOverlap(source.scope, command.scope)) continue;
      const matches = getCommandChords(command, platform, surface)
        .some((existing) => normalizedChordKey(existing, platform) === candidateKey);
      if (matches) conflicts.push({ surface, commandId: command.id, customizable: !!command.customizable });
    }
  }
  return conflicts.filter((conflict, index, rows) => rows.findIndex((row) => (
    row.surface === conflict.surface && row.commandId === conflict.commandId
  )) === index);
}

export function findShortcutConflicts(
  commands: readonly ShortcutCommand[] = SHORTCUT_COMMANDS,
): ShortcutConflict[] {
  const conflicts: ShortcutConflict[] = [];
  for (const surface of ["web", "desktop", "android"] as const) {
    for (const platform of ["macos", "windows", "linux"] as const) {
      const rows = commands
        .filter((command) => command.availableIn.includes(surface))
        .flatMap((command) => getCommandChords(command, platform, surface).map((chord) => ({
          command,
          chord,
          key: normalizedChordKey(chord, platform),
        })));
      const grouped = new Map<string, typeof rows>();
      for (const row of rows) grouped.set(row.key, [...(grouped.get(row.key) ?? []), row]);

      for (const bucket of grouped.values()) {
        const commandIds = new Set<string>();
        for (let left = 0; left < bucket.length; left += 1) {
          for (let right = left + 1; right < bucket.length; right += 1) {
            if (!scopesOverlap(bucket[left].command.scope, bucket[right].command.scope)) continue;
            commandIds.add(bucket[left].command.id);
            commandIds.add(bucket[right].command.id);
          }
        }
        if (commandIds.size > 1) {
          conflicts.push({
            surface,
            platform,
            chord: formatShortcutChord(bucket[0].chord, platform),
            commandIds: [...commandIds].sort(),
          });
        }
      }
    }
  }
  return conflicts;
}

export function resolveShortcutCommandIdByTooltipLabel(label: string): string | undefined {
  return TOOLTIP_ALIAS_TO_ID.get(normalizeLabel(label));
}

export function appendShortcutToTooltip(
  label: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  surface: ShortcutSurface = detectShortcutSurface(),
): string {
  const commandId = resolveShortcutCommandIdByTooltipLabel(label);
  const shortcut = commandId ? formatShortcutForCommand(commandId, platform, surface) : "";
  return shortcut ? `${label.replace(SHORTCUT_SUFFIX, "").trim()} (${shortcut})` : label;
}
