// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  APP_APPEARANCES,
  APP_APPEARANCE_IDS,
  APP_APPEARANCE_STORAGE_KEY,
  applyAppAppearance,
  appAppearanceTokenProperties,
  getAppAppearance,
  normalizeAppAppearanceId,
  readStoredAppAppearance,
} from "@/lib/appAppearance";

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  applyAppAppearance("default");
});

describe("App Appearance Style Capability", () => {
  it("keeps one unique seven-style registry", () => {
    expect(APP_APPEARANCE_IDS).toEqual([
      "default",
      "macos",
      "paper",
      "minimal",
      "eye-care",
      "developer",
      "magazine",
    ]);
    expect(new Set(APP_APPEARANCES.map((item) => item.id)).size).toBe(APP_APPEARANCE_IDS.length);
  });

  it("fails closed for unknown persisted appearance ids", () => {
    expect(normalizeAppAppearanceId("remote-css")).toBe("default");
    localStorage.setItem(APP_APPEARANCE_STORAGE_KEY, "javascript:alert(1)");
    expect(readStoredAppAppearance()).toBe("default");
  });

  it("projects a non-default appearance onto whole-app semantic tokens", () => {
    const root = document.documentElement;
    applyAppAppearance("paper", root);
    const tokens = getAppAppearance("paper").modes.light;

    expect(root.dataset.appAppearance).toBe("paper");
    expect(root.dataset.skin).toBe("paper");
    expect(root.style.getPropertyValue("--color-bg")).toBe(tokens.bg);
    expect(root.style.getPropertyValue("--color-sidebar")).toBe(tokens.sidebar);
    expect(root.style.getPropertyValue("--color-elevated")).toBe(tokens.elevated);
    expect(root.style.getPropertyValue("--color-accent-primary")).toBe(tokens.accentPrimary);
    expect(root.style.getPropertyValue("--pm-text")).toBe(tokens.pmText);
    expect(root.style.getPropertyValue("--radius-card")).toBe(tokens.radiusCard);
  });

  it("uses the same appearance id with dark-mode tokens instead of creating a second theme system", () => {
    const root = document.documentElement;
    root.classList.add("dark");
    applyAppAppearance("developer", root);
    const tokens = getAppAppearance("developer").modes.dark;

    expect(root.dataset.appAppearance).toBe("developer");
    expect(root.style.getPropertyValue("--color-bg")).toBe(tokens.bg);
    expect(root.style.getPropertyValue("--pm-pre-bg")).toBe(tokens.pmPreBg);
    expect(root.style.getPropertyValue("--color-accent-primary")).toBe(tokens.accentPrimary);
  });

  it("restores default by clearing only projected inline tokens", () => {
    const root = document.documentElement;
    applyAppAppearance("magazine", root);
    applyAppAppearance("default", root);

    expect(root.dataset.appAppearance).toBe("default");
    expect(root.hasAttribute("data-skin")).toBe(false);
    for (const property of appAppearanceTokenProperties()) {
      expect(root.style.getPropertyValue(property)).toBe("");
    }
  });

  it("allows only declarative local token values", () => {
    for (const appearance of APP_APPEARANCES) {
      for (const mode of ["light", "dark"] as const) {
        const serialized = JSON.stringify(appearance.modes[mode]).toLowerCase();
        expect(serialized).not.toContain("url(");
        expect(serialized).not.toContain("@import");
        expect(serialized).not.toContain("javascript:");
        expect(serialized).not.toContain("http://");
        expect(serialized).not.toContain("https://");
      }
    }
  });
});
