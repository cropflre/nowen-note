import { describe, expect, it } from "vitest";
import {
  SHORTCUT_COMMANDS,
  appendShortcutToTooltip,
  detectShortcutPlatform,
  findShortcutConflicts,
  formatShortcutForCommand,
  getShortcutCommand,
  isShortcutAllowedInTarget,
  resolveShortcutCommandIdByTooltipLabel,
  shortcutMatchesEvent,
} from "@/lib/shortcutRegistry";

describe("shortcutRegistry", () => {
  it("formats platform-specific modifier labels", () => {
    expect(formatShortcutForCommand("bold", "windows", "web")).toBe("Ctrl+B");
    expect(formatShortcutForCommand("bold", "linux", "web")).toBe("Ctrl+B");
    expect(formatShortcutForCommand("bold", "macos", "web")).toBe("⌘B");
    expect(formatShortcutForCommand("shortcut-help", "macos", "desktop")).toBe("⌘⇧/");
  });

  it("uses surface-specific bindings instead of advertising browser-reserved shortcuts", () => {
    expect(formatShortcutForCommand("new-note", "windows", "web")).toBe("Alt+N");
    expect(formatShortcutForCommand("new-note", "windows", "desktop")).toBe("Ctrl+N");
    expect(formatShortcutForCommand("new-note", "macos", "desktop")).toBe("⌘N");
    expect(formatShortcutForCommand("global-search", "windows", "web")).toBe("");
    expect(formatShortcutForCommand("global-search", "windows", "desktop")).toBe("Ctrl+F");
    expect(getShortcutCommand("shortcut-help")?.availableIn).toEqual(["web", "desktop"]);
  });

  it("keeps active command-palette command IDs backed by the registry", () => {
    expect(getShortcutCommand("toggle-note-list")).toBeUndefined();
    for (const commandId of [
      "toggle-editor-fullscreen",
      "split-right",
      "split-down",
      "close-split",
    ]) {
      expect(getShortcutCommand(commandId), commandId).toBeDefined();
    }
    expect(formatShortcutForCommand("command-palette", "windows", "web")).toBe("Ctrl+K");
    expect(formatShortcutForCommand("toggle-note-list", "windows", "web")).toBe("");
    expect(formatShortcutForCommand("split-right", "windows", "web")).toBe("");
  });

  it("detects the current desktop platform", () => {
    expect(detectShortcutPlatform({ platform: "MacIntel" })).toBe("macos");
    expect(detectShortcutPlatform({ platform: "Win32" })).toBe("windows");
    expect(detectShortcutPlatform({ platform: "Linux x86_64" })).toBe("linux");
  });

  it("keeps the default registry free of overlapping shortcut conflicts per surface", () => {
    expect(findShortcutConflicts(SHORTCUT_COMMANDS)).toEqual([]);
  });

  it("matches keyboard events using Mod and surface semantics", () => {
    expect(shortcutMatchesEvent("shortcut-help", {
      key: "?",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }, "windows", "web")).toBe(true);

    expect(shortcutMatchesEvent("new-note", {
      key: "n",
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
    }, "windows", "web")).toBe(true);

    expect(shortcutMatchesEvent("new-note", {
      key: "n",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }, "windows", "web")).toBe(false);
  });

  it("resolves localized toolbar labels and appends the right shortcut", () => {
    expect(resolveShortcutCommandIdByTooltipLabel("加粗")).toBe("bold");
    expect(resolveShortcutCommandIdByTooltipLabel("Heading 3")).toBe("heading-3");
    expect(appendShortcutToTooltip("加粗", "windows", "web")).toBe("加粗 (Ctrl+B)");
    expect(appendShortcutToTooltip("清除格式 (Ctrl+Shift+X)", "windows", "web"))
      .toBe("清除格式 (Ctrl+Shift+X)");
  });

  it("exposes shared Markdown categories without duplicating command IDs", () => {
    expect(getShortcutCommand("bold")?.secondaryCategories).toContain("markdown");
    expect(new Set(SHORTCUT_COMMANDS.map((command) => command.id)).size).toBe(SHORTCUT_COMMANDS.length);
  });

  it("enforces shortcut target scopes", () => {
    const input = document.createElement("input");
    const div = document.createElement("div");
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.className = "ProseMirror";
    expect(isShortcutAllowedInTarget("command-palette", input)).toBe(false);
    expect(isShortcutAllowedInTarget("command-palette", div)).toBe(true);
    expect(isShortcutAllowedInTarget("bold", input)).toBe(false);
    expect(isShortcutAllowedInTarget("bold", editor)).toBe(true);
    expect(isShortcutAllowedInTarget("toggle-note-list", input)).toBe(false);
  });
});
