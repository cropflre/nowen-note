import { describe, expect, it } from "vitest";
import {
  SHORTCUT_COMMANDS,
  appendShortcutToTooltip,
  detectShortcutPlatform,
  findShortcutConflicts,
  formatShortcutForCommand,
  resolveShortcutCommandIdByTooltipLabel,
  shortcutMatchesEvent,
} from "@/lib/shortcutRegistry";

describe("shortcutRegistry", () => {
  it("formats platform-specific modifier labels", () => {
    expect(formatShortcutForCommand("bold", "windows")).toBe("Ctrl+B");
    expect(formatShortcutForCommand("bold", "linux")).toBe("Ctrl+B");
    expect(formatShortcutForCommand("bold", "macos")).toBe("⌘B");
    expect(formatShortcutForCommand("shortcut-help", "macos")).toBe("⌘⇧/");
  });

  it("detects the current desktop platform", () => {
    expect(detectShortcutPlatform({ platform: "MacIntel" })).toBe("macos");
    expect(detectShortcutPlatform({ platform: "Win32" })).toBe("windows");
    expect(detectShortcutPlatform({ platform: "Linux x86_64" })).toBe("linux");
  });

  it("keeps the default registry free of overlapping shortcut conflicts", () => {
    expect(findShortcutConflicts(SHORTCUT_COMMANDS)).toEqual([]);
  });

  it("matches keyboard events using Mod semantics", () => {
    expect(shortcutMatchesEvent("shortcut-help", {
      key: "?",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }, "windows")).toBe(true);

    expect(shortcutMatchesEvent("shortcut-help", {
      key: "/",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: true,
    }, "macos")).toBe(true);
  });

  it("resolves localized toolbar labels and appends the right shortcut", () => {
    expect(resolveShortcutCommandIdByTooltipLabel("加粗")).toBe("bold");
    expect(resolveShortcutCommandIdByTooltipLabel("Heading 3")).toBe("heading-3");
    expect(appendShortcutToTooltip("加粗", "windows")).toBe("加粗 (Ctrl+B)");
    expect(appendShortcutToTooltip("清除格式 (Ctrl+Shift+X)", "windows"))
      .toBe("清除格式 (Ctrl+Shift+X)");
  });
});
