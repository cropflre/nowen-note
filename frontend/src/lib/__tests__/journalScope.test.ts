import { describe, expect, it, vi } from "vitest";

import {
  checkJournalForScope,
  getOrCreateJournalForScope,
  resolveJournalScope,
  scopedJournalToastMessage,
} from "@/lib/journalScope";

describe("journal scope", () => {
  it("maps personal and workspace storage values to explicit scopes", () => {
    expect(resolveJournalScope("personal")).toEqual({
      kind: "personal",
      workspaceId: null,
      key: "personal",
      label: "个人日记",
    });
    expect(resolveJournalScope("workspace-one")).toEqual({
      kind: "workspace",
      workspaceId: "workspace-one",
      key: "workspace:workspace-one",
      label: "工作区日记",
    });
  });

  it("routes creation to the active workspace without calling personal journals", async () => {
    const getOrCreatePersonal = vi.fn();
    const getOrCreateWorkspace = vi.fn().mockResolvedValue({
      id: "workspace-note",
      title: "2026-08-03",
      existed: false,
      canWrite: true,
    });

    await expect(getOrCreateJournalForScope(
      "2026-08-03",
      resolveJournalScope("workspace-one"),
      { getOrCreatePersonal, getOrCreateWorkspace },
    )).resolves.toMatchObject({
      id: "workspace-note",
      workspaceId: "workspace-one",
      scope: "workspace",
      canWrite: true,
    });

    expect(getOrCreateWorkspace).toHaveBeenCalledWith("workspace-one", "2026-08-03");
    expect(getOrCreatePersonal).not.toHaveBeenCalled();
  });

  it("keeps personal journal behavior unchanged", async () => {
    const getOrCreatePersonal = vi.fn().mockResolvedValue({
      id: "personal-note",
      title: "2026-08-03",
      existed: true,
    });
    const getOrCreateWorkspace = vi.fn();

    await expect(getOrCreateJournalForScope(
      "2026-08-03",
      resolveJournalScope("personal"),
      { getOrCreatePersonal, getOrCreateWorkspace },
    )).resolves.toMatchObject({
      id: "personal-note",
      workspaceId: null,
      scope: "personal",
      canWrite: true,
    });

    expect(getOrCreatePersonal).toHaveBeenCalledWith("2026-08-03");
    expect(getOrCreateWorkspace).not.toHaveBeenCalled();
  });

  it("preserves read-only workspace capability from the server", async () => {
    const checkWorkspace = vi.fn().mockResolvedValue({
      exists: true,
      noteId: "shared-note",
      canWrite: false,
      role: "viewer",
    });

    await expect(checkJournalForScope(
      "2026-08-03",
      resolveJournalScope("workspace-one"),
      { checkWorkspace },
    )).resolves.toMatchObject({
      exists: true,
      noteId: "shared-note",
      canWrite: false,
      scope: "workspace",
    });
  });

  it("uses distinct success copy for workspace links", () => {
    expect(scopedJournalToastMessage({ existed: false, scope: "workspace" }, "2026-08-03"))
      .toBe("已创建并链接工作区 2026-08-03 日记");
    expect(scopedJournalToastMessage({ existed: true, scope: "personal" }, "2026-08-03"))
      .toBe("已链接 2026-08-03 日记");
  });
});
