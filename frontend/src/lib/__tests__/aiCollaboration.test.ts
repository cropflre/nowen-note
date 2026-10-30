import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), workspace: "personal" }));
vi.mock("@/lib/api", () => ({ api: { createNote: mocks.create, getNote: mocks.get }, getBaseUrl: () => "https://notes.example/api", getCurrentWorkspace: () => mocks.workspace }));
import { collaborationDraftKey, collaborationRequest, collaborationScope, emptyCollaborationDraft, makeCollaborationSave, readCollaborationDraft, saveCollaborationNote, suggestSkills } from "../aiCollaboration";
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); mocks.workspace = "personal"; });
describe("AI capture defaults and persistence", () => {
  it("starts in automatic mode without requiring a folder or Skill selection", () => {
    expect(emptyCollaborationDraft()).toMatchObject({ input: "", skillKey: "auto", projectId: "", libraryId: "" });
  });
  it("matches Chinese and English titles and limits suggestions", () => {
    const skills = [{ key: "a", name: "项目策划书" }, { key: "b", name: "灵感整理" }, { key: "c", name: "Project brief" }];
    expect(suggestSkills("根据项目现状新增一个功能，写份策划书", skills)[0].key).toBe("a");
    expect(suggestSkills("A project BRIEF for the launch", skills)[0].key).toBe("c");
    expect(suggestSkills("", skills)).toEqual([]);
  });
  it("keeps raw ideas in generated notes and preserves source identity", () => {
    const draft = { ...emptyCollaborationDraft(), input: "A rough idea", output: "# Proposal\n\nNew feature", targetId: "folder", references: [{ id: "source", title: "Project [A]" }] };
    const request = makeCollaborationSave(draft, "Original", "Sources");
    expect(request.title).toBe("Proposal"); expect(request.content).toContain("A rough idea"); expect(request.content).toContain("/notes/source");
    expect(makeCollaborationSave(draft, "Original", "Sources", true).content).toBe("A rough idea");
  });
  it("restores draft and frozen save identity only within its original account and space", () => {
    const scope = collaborationScope(); const draft = { ...emptyCollaborationDraft(), input: "private idea", output: "Draft", targetId: "folder" };
    const request = makeCollaborationSave(draft, "Original", "Sources");
    localStorage.setItem(collaborationDraftKey(scope), JSON.stringify({ ...draft, saveRequest: request }));
    expect(readCollaborationDraft(scope).saveRequest!.id).toBe(request.id);
    mocks.workspace = "another-space";
    expect(readCollaborationDraft(collaborationScope()).input).toBe("");
    expect(readCollaborationDraft(scope).input).toBe("private idea");
  });
  it("accepts a lost-response retry only when the exact note already exists", async () => {
    const scope = collaborationScope(); const draft = { ...emptyCollaborationDraft(), input: "idea", targetId: "folder" };
    const request = makeCollaborationSave(draft, "Original", "Sources", true);
    mocks.create.mockRejectedValue(new Error("response lost")); mocks.get.mockResolvedValue(request);
    await expect(saveCollaborationNote(request, scope)).resolves.toMatchObject({ id: request.id });
    mocks.get.mockResolvedValue({ ...request, content: "different" });
    await expect(saveCollaborationNote(request, scope)).rejects.toThrow("response lost");
    expect(mocks.create.mock.calls.every(call => call[0].id === request.id)).toBe(true);
  });
  it("never starts a save after the account or space changed", async () => {
    const scope = collaborationScope(); mocks.workspace = "new-space";
    await expect(saveCollaborationNote({ id: "id", notebookId: "folder", title: "Note", content: "idea", contentFormat: "markdown" }, scope)).rejects.toThrow("SCOPE_CHANGED");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects late generation responses after scope changes", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => { mocks.workspace = "new-space"; return new Response(JSON.stringify({ content: "late" })); });
    try { await expect(collaborationRequest("compose", { input: "private idea" })).rejects.toThrow("SCOPE_CHANGED"); }
    finally { globalThis.fetch = oldFetch; }
  });
});
