import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("settings switches contract", () => {
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
