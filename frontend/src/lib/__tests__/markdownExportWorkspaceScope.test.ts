import { describe, expect, it, vi } from "vitest";
import { resolveMarkdownExportWorkspaceId } from "@/lib/markdownExportWorkspaceScope";

describe("markdown export workspace scope", () => {
  it("uses the team workspace stored on a single note instead of the active UI workspace", async () => {
    const getNoteWorkspaceId = vi.fn().mockResolvedValue("workspace-team");

    await expect(resolveMarkdownExportWorkspaceId({
      noteIds: ["note-team"],
      currentWorkspace: "personal",
      getNoteWorkspaceId,
    })).resolves.toBe("workspace-team");

    expect(getNoteWorkspaceId).toHaveBeenCalledWith("note-team");
  });

  it("keeps personal single-note export in personal scope", async () => {
    await expect(resolveMarkdownExportWorkspaceId({
      noteIds: ["note-personal"],
      currentWorkspace: "workspace-team",
      getNoteWorkspaceId: vi.fn().mockResolvedValue(null),
    })).resolves.toBe("personal");
  });

  it("does not override an explicit workspace supplied by bulk export", async () => {
    const getNoteWorkspaceId = vi.fn();

    await expect(resolveMarkdownExportWorkspaceId({
      explicitWorkspaceId: "workspace-explicit",
      noteIds: ["note-a", "note-b"],
      currentWorkspace: "workspace-current",
      getNoteWorkspaceId,
    })).resolves.toBe("workspace-explicit");

    expect(getNoteWorkspaceId).not.toHaveBeenCalled();
  });

  it("falls back to the current workspace when an older backend omits workspaceId", async () => {
    await expect(resolveMarkdownExportWorkspaceId({
      noteIds: ["note-legacy"],
      currentWorkspace: "workspace-current",
      getNoteWorkspaceId: vi.fn().mockResolvedValue(undefined),
    })).resolves.toBe("workspace-current");
  });
});
