import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("journal archive cleanup contract", () => {
  it("exposes preview, apply and restore APIs", () => {
    const api = source("../../../lib/api.impl.ts");
    expect(api).toContain("previewArchiveCleanup:");
    expect(api).toContain('"/journals/cleanup-preview"');
    expect(api).toContain("cleanupArchive:");
    expect(api).toContain('"/journals/cleanup"');
    expect(api).toContain("restoreArchiveCleanup:");
    expect(api).toContain('"/journals/cleanup/restore"');
  });

  it("requires a preview confirmation and keeps an undo action", () => {
    const view = source("../DailyJournalView.tsx");
    expect(view).toContain("previewArchiveCleanup()");
    expect(view).toContain("preview.previewToken");
    expect(view).toContain("confirmDialog({");
    expect(view).toContain("只会软删除经过迁移历史验证的空叶子目录");
    expect(view).toContain("restoreArchiveCleanup(lastCleanupId)");
    expect(view).toContain("nowen.journalArchive.lastCleanupId");
    expect(view).toContain('reason: "journal-archive-cleaned"');
    expect(view).toContain('reason: "journal-archive-cleanup-restored"');
  });
});
