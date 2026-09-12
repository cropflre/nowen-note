import { describe, expect, it } from "vitest";
import {
  DEFAULT_USER_PREFERENCES,
  LEGACY_CODE_BLOCK_THEME_KEY,
  LEGACY_EDITOR_MODE_KEY,
  LEGACY_NOTE_LIST_TITLE_ONLY_KEY,
  LEGACY_USER_PREFERENCES_KEY,
  accountPreferenceStorageKey,
  claimLegacyUserPreferences,
  decodeUserIdFromToken,
  mergePendingPreferences,
  readAccountPreferenceCache,
  sanitizeUserPreferencePatch,
  writeAccountPreferenceCache,
  type StorageLike,
} from "../userPreferenceAccountCache";

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function tokenFor(userId: string): string {
  const base64url = (value: object) => Buffer.from(JSON.stringify(value))
    .toString("base64url");
  return `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ userId })}.signature`;
}

describe("user preference account cache", () => {
  it("derives the cache identity from the authenticated JWT", () => {
    expect(decodeUserIdFromToken(tokenFor("user-a"))).toBe("user-a");
    expect(decodeUserIdFromToken("invalid-token")).toBeNull();
  });

  it("strictly separates preference caches for different accounts", () => {
    const storage = new MemoryStorage();
    writeAccountPreferenceCache(storage, {
      version: 2,
      userId: "user-a",
      prefs: {
        ...DEFAULT_USER_PREFERENCES,
        readingDensity: "compact",
        editorFontSize: 22,
        codeBlockTheme: "nord",
        noteTheme: "paper",
      },
      revision: 3,
      pending: { readingDensity: "compact", editorFontSize: 22, codeBlockTheme: "nord", noteTheme: "paper" },
    });
    writeAccountPreferenceCache(storage, {
      version: 2,
      userId: "user-b",
      prefs: {
        ...DEFAULT_USER_PREFERENCES,
        enableNoteTabs: true,
        defaultEditorMode: "md",
      },
      revision: 7,
      pending: {},
    });

    expect(accountPreferenceStorageKey("user-a")).not.toBe(accountPreferenceStorageKey("user-b"));
    expect(readAccountPreferenceCache(storage, "user-a")?.prefs.readingDensity).toBe("compact");
    expect(readAccountPreferenceCache(storage, "user-a")?.prefs.editorFontSize).toBe(22);
    expect(readAccountPreferenceCache(storage, "user-a")?.prefs.codeBlockTheme).toBe("nord");
    expect(readAccountPreferenceCache(storage, "user-a")?.prefs.noteTheme).toBe("paper");
    expect(readAccountPreferenceCache(storage, "user-a")?.prefs.enableNoteTabs).toBe(false);
    expect(readAccountPreferenceCache(storage, "user-b")?.prefs.enableNoteTabs).toBe(true);
    expect(readAccountPreferenceCache(storage, "user-b")?.prefs.defaultEditorMode).toBe("md");
    expect(readAccountPreferenceCache(storage, "user-b")?.revision).toBe(7);
  });

  it("allows the legacy browser-wide cache to be claimed by only one account", () => {
    const storage = new MemoryStorage();
    storage.setItem(LEGACY_USER_PREFERENCES_KEY, JSON.stringify({
      noteTitleAsAppTitle: true,
      markdownDefaultViewMode: "preview",
    }));
    storage.setItem(LEGACY_EDITOR_MODE_KEY, "md");
    storage.setItem(LEGACY_CODE_BLOCK_THEME_KEY, "dracula");
    storage.setItem(LEGACY_NOTE_LIST_TITLE_ONLY_KEY, "true");

    const first = claimLegacyUserPreferences(storage, "user-a");
    const second = claimLegacyUserPreferences(storage, "user-b");

    expect(first?.noteTitleAsAppTitle).toBe(true);
    expect(first?.markdownDefaultViewMode).toBe("preview");
    expect(first?.defaultEditorMode).toBe("md");
    expect(first?.codeBlockTheme).toBe("dracula");
    expect(first?.noteListTitleOnly).toBe(true);
    expect(second).toBeNull();
  });

  it("keeps offline pending fields on top of a newer remote document", () => {
    const merged = mergePendingPreferences(
      { ...DEFAULT_USER_PREFERENCES, noteTitleAsAppTitle: true },
      {
        readingDensity: "compact",
        enableNoteTabs: true,
        noteListTitleOnly: true,
      },
    );

    expect(merged.noteTitleAsAppTitle).toBe(true);
    expect(merged.readingDensity).toBe("compact");
    expect(merged.enableNoteTabs).toBe(true);
    expect(merged.noteListTitleOnly).toBe(true);
  });

  it("drops unknown and sensitive fields from local pending payloads", () => {
    const patch = sanitizeUserPreferencePatch({
      enableNoteTabs: true,
      editorFontSize: 20,
      codeBlockTheme: "nord",
      noteTheme: "minimal",
      apiKey: "secret",
      token: "secret-token",
    });

    expect(patch).toEqual({ enableNoteTabs: true, editorFontSize: 20, codeBlockTheme: "nord", noteTheme: "minimal" });
    expect(JSON.stringify(patch)).not.toContain("secret");
  });

  it("keeps supported editor font sizes and falls back for invalid values", () => {
    const storage = new MemoryStorage();
    writeAccountPreferenceCache(storage, {
      version: 2,
      userId: "user-a",
      prefs: { ...DEFAULT_USER_PREFERENCES, editorFontSize: 24 },
      revision: 1,
      pending: {},
    });
    storage.setItem(accountPreferenceStorageKey("user-b"), JSON.stringify({
      version: 2,
      userId: "user-b",
      prefs: { ...DEFAULT_USER_PREFERENCES, editorFontSize: 48 },
      revision: 1,
      pending: { editorFontSize: 48 },
    }));

    expect(readAccountPreferenceCache(storage, "user-a")?.prefs.editorFontSize).toBe(24);
    expect(readAccountPreferenceCache(storage, "user-b")?.prefs.editorFontSize).toBe(0);
    expect(readAccountPreferenceCache(storage, "user-b")?.pending.editorFontSize).toBe(0);
  });

  it("falls back to the default note theme for unknown theme identifiers", () => {
    const storage = new MemoryStorage();
    storage.setItem(accountPreferenceStorageKey("user-a"), JSON.stringify({
      version: 2,
      userId: "user-a",
      prefs: { ...DEFAULT_USER_PREFERENCES, noteTheme: "unsafe-css-theme" },
      revision: 1,
      pending: { noteTheme: "unsafe-css-theme" },
    }));
    expect(readAccountPreferenceCache(storage, "user-a")?.prefs.noteTheme).toBe("default");
    expect(readAccountPreferenceCache(storage, "user-a")?.pending.noteTheme).toBe("default");
  });
});
