// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { applyExplicitNoteTheme } from "@/lib/noteAppearanceSurface";
import {
  listAvailableNoteThemes,
  replacePluginNoteThemes,
  resolveRegisteredNoteTheme,
} from "@/lib/pluginNoteThemeRegistry";
import { resolveNoteThemeTokens } from "@/lib/noteTheme";

const contribution = {
  pluginId: "nowenlab.theme-pack",
  publisher: "nowenlab",
  noteThemes: [{
    id: "sepia",
    name: "Sepia",
    modes: {
      light: { surface: "#fbf3df", text: "#4d4030", contentMaxWidth: "760px", lineHeight: "1.82" },
      dark: { surface: "#211c16", text: "#eadcc7" },
    },
  }],
};

afterEach(() => {
  replacePluginNoteThemes([]);
});

describe("Plugin Note Theme Registry", () => {
  it("namespaces contributions and merges safe overrides onto the host base", () => {
    expect(replacePluginNoteThemes([contribution])).toBe(1);
    expect(listAvailableNoteThemes().some((theme) => theme.id === "nowenlab.theme-pack/sepia")).toBe(true);
    const resolved = resolveRegisteredNoteTheme("nowenlab.theme-pack/sepia", "light");
    expect(resolved.available).toBe(true);
    expect(resolved.tokens.surface).toBe("#fbf3df");
    expect(resolved.tokens.border).toBe(resolveNoteThemeTokens("default", "light").border);
  });

  it("falls back visually while retaining the unavailable requested id", () => {
    const surface = document.createElement("div");
    expect(applyExplicitNoteTheme(surface, "nowenlab.theme-pack/sepia")).toBe(false);
    expect(surface.dataset.noteTheme).toBe("default");
    expect(surface.dataset.noteThemeRequested).toBe("nowenlab.theme-pack/sepia");
    expect(surface.hasAttribute("data-note-theme-fallback")).toBe(true);

    replacePluginNoteThemes([contribution]);
    expect(applyExplicitNoteTheme(surface, "nowenlab.theme-pack/sepia")).toBe(true);
    expect(surface.dataset.noteTheme).toBe("nowenlab.theme-pack/sepia");
  });

  it("uses the complete host dark theme when a plugin omits dark overrides", () => {
    replacePluginNoteThemes([{
      pluginId: "nowenlab.theme-pack",
      noteThemes: [{ id: "light-only", name: "Light only", modes: { light: { surface: "#fbf3df" } } }],
    }]);
    const resolved = resolveRegisteredNoteTheme("nowenlab.theme-pack/light-only", "dark");
    expect(resolved.available).toBe(true);
    expect(resolved.tokens.surface).toBe(resolveNoteThemeTokens("default", "dark").surface);
    expect(resolved.tokens.surface).not.toBe("#fbf3df");
  });

  it("rejects unsafe or unknown declarative token values defensively", () => {
    expect(replacePluginNoteThemes([{
      pluginId: "nowenlab.theme-pack",
      noteThemes: [{ id: "bad", name: "Bad", modes: { light: { surface: "url(x)" } } }],
    }])).toBe(0);
  });
});
