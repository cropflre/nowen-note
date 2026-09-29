import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("settings switches contract", () => {
  it("exposes an account-synced note-list divider switch without changing the updated-time placement", () => {
    const settings = source("../../components/SettingsModal.tsx");
    const noteList = source("../../components/NoteList.tsx");
    const zh = source("../../i18n/locales/zh-CN.json");
    const en = source("../../i18n/locales/en.json");

    expect(settings).toContain('key: "showNoteListDividers" as const');
    expect(noteList).toContain("userPrefs.prefs.showNoteListDividers");
    expect(noteList).toContain('data-note-list-divider={showDivider ? "on" : "off"}');
    expect(noteList).toContain("border-b-app-border/70");
    expect(noteList).toContain('t("noteList.showDividers")');
    expect(zh).toContain('"showNoteListDividers"');
    expect(en).toContain('"showNoteListDividers"');
  });

  it("removes the global updated-time switch while preserving functional note-list support", () => {
    const settings = source("../../components/SettingsModal.tsx");
    const noteList = source("../../components/NoteList.tsx");
    const zh = source("../../i18n/locales/zh-CN.json");
    const en = source("../../i18n/locales/en.json");

    expect(settings).not.toContain('key: "showNoteListUpdatedTime" as const');
    expect(zh).not.toContain('"prefShowNoteListUpdatedTime"');
    expect(en).not.toContain('"prefShowNoteListUpdatedTime"');
    expect(noteList).toContain("userPrefs.prefs.showNoteListUpdatedTime");
  });
});
