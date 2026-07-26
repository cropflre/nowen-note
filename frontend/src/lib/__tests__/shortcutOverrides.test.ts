import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHORTCUT_OVERRIDES_CHANGED_EVENT,
  SHORTCUT_OVERRIDES_STORAGE_KEY,
  exportShortcutOverrides,
  getShortcutOverride,
  importShortcutOverrides,
  resetAllShortcutOverrides,
  resetShortcutOverride,
  setShortcutOverride,
  shortcutChordFromKeyboardEvent,
} from "@/lib/shortcutOverrides";
import {
  SHORTCUT_COMMANDS,
  detectShortcutPlatform,
  findShortcutConflictsForCandidate,
  getShortcutChords,
  validateShortcutChord,
} from "@/lib/shortcutRegistry";
import { enhanceShortcutTooltips } from "@/lib/shortcutTooltipBridge";

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("shortcutOverrides", () => {
  it("stores overrides per platform and emits change events", () => {
    const listener = vi.fn();
    window.addEventListener(SHORTCUT_OVERRIDES_CHANGED_EVENT, listener);

    setShortcutOverride("bold", "windows", [["Mod", "Shift", "B"]]);

    expect(getShortcutOverride("bold", "windows")).toEqual([["Mod", "Shift", "B"]]);
    expect(getShortcutOverride("bold", "macos")).toBeUndefined();
    expect(JSON.parse(exportShortcutOverrides())).toEqual({
      version: 1,
      platforms: { windows: { bold: [["Mod", "Shift", "B"]] } },
    });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(SHORTCUT_OVERRIDES_CHANGED_EVENT, listener);
  });

  it("supports clearing, single reset and platform reset", () => {
    setShortcutOverride("bold", "windows", []);
    setShortcutOverride("italic", "windows", [["Mod", "Alt", "I"]]);
    expect(getShortcutChords("bold", "windows", "web")).toEqual([]);

    resetShortcutOverride("bold", "windows");
    expect(getShortcutChords("bold", "windows", "web")).toEqual([["Mod", "B"]]);

    resetAllShortcutOverrides("windows");
    expect(getShortcutOverride("italic", "windows")).toBeUndefined();
  });

  it("falls back safely when persisted data is corrupt", () => {
    localStorage.setItem(SHORTCUT_OVERRIDES_STORAGE_KEY, "{not-json");
    expect(getShortcutOverride("bold", "windows")).toBeUndefined();
    expect(() => exportShortcutOverrides()).not.toThrow();
  });

  it("imports only known customizable commands with valid chords", () => {
    const validCommandIds = new Set(SHORTCUT_COMMANDS.map((command) => command.id));
    const customizableCommandIds = new Set(
      SHORTCUT_COMMANDS.filter((command) => command.customizable).map((command) => command.id),
    );
    const count = importShortcutOverrides(JSON.stringify({
      version: 1,
      platforms: { windows: { bold: [["Mod", "Shift", "B"]] } },
    }), {
      validCommandIds,
      customizableCommandIds,
      validateChord: (chord, platform, commandId) => validateShortcutChord(chord, platform, "web", commandId),
    });
    expect(count).toBe(1);
    expect(getShortcutOverride("bold", "windows")).toEqual([["Mod", "Shift", "B"]]);

    expect(() => importShortcutOverrides(JSON.stringify({
      version: 1,
      platforms: { windows: { "missing-command": [["Mod", "B"]] } },
    }), {
      validCommandIds,
      customizableCommandIds,
      validateChord: () => null,
    })).toThrow("未知命令");
  });

  it("rejects dangerous or input-hostile chords", () => {
    expect(validateShortcutChord(["Mod", "R"], "windows", "web", "bold")).toContain("不可覆盖");
    expect(validateShortcutChord(["Shift", "B"], "windows", "web", "bold")).toContain("必须包含");
    expect(validateShortcutChord(["Alt", "B"], "windows", "web", "bold")).toBeNull();
  });

  it("captures platform modifiers and reports conflicting commands", () => {
    expect(shortcutChordFromKeyboardEvent({
      key: "b",
      metaKey: false,
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      isComposing: false,
    }, "windows")).toEqual(["Mod", "Alt", "B"]);

    const conflicts = findShortcutConflictsForCandidate("italic", ["Mod", "B"], "windows");
    expect(conflicts.some((conflict) => conflict.commandId === "bold")).toBe(true);
  });

  it("removes stale tooltip hints after a binding is cleared", () => {
    const button = document.createElement("button");
    button.title = "加粗";
    document.body.appendChild(button);

    enhanceShortcutTooltips(document);
    expect(button.title).toContain("B");

    setShortcutOverride("bold", detectShortcutPlatform(), []);
    enhanceShortcutTooltips(document);
    expect(button.title).toBe("加粗");
    expect(button.dataset.shortcutEnhancedTitle).toBeUndefined();
  });
});
