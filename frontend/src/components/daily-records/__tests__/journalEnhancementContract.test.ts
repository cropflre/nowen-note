import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("journal enhancement contract", () => {
  it("keeps journals on note storage while exposing a lightweight filterable archive", () => {
    const archive = source("../../JournalArchive.tsx");
    const api = source("../../../lib/api.impl.ts");
    expect(archive).toContain("api.journals.list({");
    expect(archive).toContain('placeholder="搜索日记"');
    expect(archive).toContain("全部心情");
    expect(archive).toContain("最近编辑");
    expect(api).toContain("tzOffsetMinutes");
    expect(api).toContain("ensurePrivacyRoot");
  });

  it("gates the actual journal entry point and reuses note capabilities for subtitle/share", () => {
    const hub = source("../DailyRecordsHub.tsx");
    const view = source("../DailyJournalView.tsx");
    expect(hub).toContain("<JournalPrivacyGate");
    expect(view).toContain("api.updateNote(journal.id, { title: nextTitle })");
    expect(view).toContain("<ShareModal");
    expect(view).toContain("<JournalArchive");
    expect(view).toContain("给这一天写个副标题");
    expect(view).toContain("工作区日志");
  });

  it("reuses folder password sessions for the personal journal gate", () => {
    const gate = source("../JournalPrivacyGate.tsx");
    expect(gate).toContain("FolderPasswordDialog");
    expect(gate).toContain("forgetUnlockedFolder");
    expect(gate).toContain("rememberUnlockedFolder");
    expect(gate).toContain("prefs.journalLockOnEntry");
    expect(gate).toContain("工作区日志");
  });
});
