import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("workspace shared journal contract", () => {
  it("exposes workspace check and resolve APIs", () => {
    const api = source("../../../lib/api.impl.ts");
    expect(api).toContain("getOrCreateWorkspace:");
    expect(api).toContain("checkWorkspace:");
    expect(api).toContain("/journals/workspace/");
    expect(api).toContain("workspace-journal-created");
  });

  it("defaults a workspace session to shared journals and keeps a personal toggle", () => {
    const hub = source("../DailyRecordsHub.tsx");
    const view = source("../DailyJournalView.tsx");

    expect(hub).toContain("resolveJournalScope(nextWorkspace)");
    expect(hub).toContain("journalScope={journalScope}");
    expect(hub).toContain("activeWorkspaceId={activeWorkspaceId}");
    expect(hub).not.toContain("日期日记仍保存在你的个人空间");

    expect(view).toContain('data-journal-scope-switch=""');
    expect(view).toContain('resolveJournalScope("personal")');
    expect(view).toContain("resolveJournalScope(activeWorkspaceId)");
    expect(view).toContain('journalScope.kind === "workspace" ? "工作区日记" : "个人日记"');
  });

  it("loads and creates notes within the selected scope", () => {
    const view = source("../DailyJournalView.tsx");
    expect(view).toContain("checkJournalForScope(selectedDate, journalScope)");
    expect(view).toContain("getOrCreateJournalForScope(selectedDate, journalScope)");
    expect(view).toContain("knowledgeTreeApi.listForWorkspace(treeWorkspaceId)");
    expect(view).toContain("knowledgeTreeApi.createForWorkspace(targetWorkspaceId");
  });

  it("keeps personal maintenance tools out of workspace scope and disables read-only writes", () => {
    const view = source("../DailyJournalView.tsx");
    expect(view).toContain('journalScope.kind === "personal"');
    expect(view).toContain("disabled={creating || !journalCanWrite}");
    expect(view).toContain("disabled={!journalCanWrite}");
    expect(view).toContain("当前角色只能查看");
    expect(view).toContain("工作区协作");
  });

  it("routes both editor slash implementations through the shared scope resolver", () => {
    const rich = source("../dailyRecordSlashCommands.tsx");
    const markdown = source("../markdownDailyRecordSlashCommands.tsx");
    expect(rich).toContain("getOrCreateJournalForScope(dateKey, scope)");
    expect(markdown).toContain("getOrCreateJournalForScope(");
    expect(rich).not.toContain("当前工作区成员可能无法访问");
    expect(markdown).not.toContain("当前工作区成员可能无法访问");
  });
});
