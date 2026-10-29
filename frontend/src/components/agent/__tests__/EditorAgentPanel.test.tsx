import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { Note } from "@/types";
const mocks = vi.hoisted(() => ({ capabilities: vi.fn(), latest: vi.fn(), get: vi.fn(), create: vi.fn(), approve: vi.fn(), action: vi.fn(), getNote: vi.fn(), skills: vi.fn(), scope: "account-a", t: (key: string) => key }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("@/lib/api", () => ({ api: { agent: mocks, getNote: mocks.getNote, aiPrompts: { list: mocks.skills } } }));
vi.mock("@/lib/aiCollaboration", () => ({ collaborationScope: () => mocks.scope }));
import EditorAgentPanel from "../EditorAgentPanel";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const proposal = { original: "original", result: "improved", format: "markdown", edits: [{ before: "original", after: "improved" }], token: "a".repeat(64) };
const run = { id: "run", noteId: "note", status: "waiting_approval", steps: [], proposal };
let host: HTMLDivElement, root: Root, current: string, selection: string;
const apply = vi.fn((original: string) => current === original), flush = vi.fn();
const editor = () => ({ getSnapshot: () => ({ content: current, contentText: current }), getAgentSelection: () => selection, applyAgentEdits: apply, flushSave: flush });
beforeEach(() => {
  vi.clearAllMocks(); current = "original"; selection = ""; mocks.scope = "account-a";
  mocks.skills.mockResolvedValue({ items: [{ id: "review", name: "Review", prompt: "PRIVATE SKILL" }] });
  mocks.capabilities.mockResolvedValue({ enabled: true }); mocks.latest.mockResolvedValue(run);
  mocks.action.mockResolvedValue({ ...run, status: "cancelled", proposal: undefined });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function render() { await act(async () => root.render(<EditorAgentPanel note={{ id: "note", contentFormat: "markdown" } as Note} editor={editor} onClose={() => {}} />)); }
async function click(label: string) { const button = [...host.querySelectorAll("button")].find(b => b.textContent === label)!; await act(async () => button.click()); }
it("does not approve a proposal when newer local typing already exists", async () => {
  await render(); current = "new typing"; await click("agent.accept"); expect(mocks.approve).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled();
});
it("rechecks editor content after approval response and never applies over newer typing", async () => {
  let resolve!: (value: unknown) => void; mocks.approve.mockImplementation(() => new Promise(r => { resolve = r; }));
  await render(); await click("agent.accept"); current = "typed while waiting";
  await act(async () => { resolve(proposal); });
  expect(apply).toHaveBeenCalledWith("original", proposal.edits); expect(flush).not.toHaveBeenCalled(); expect(mocks.action).toHaveBeenCalledWith("run", "cancel");
});
it("reject leaves editor untouched and previews model HTML as text", async () => {
  mocks.latest.mockResolvedValue({ ...run, proposal: { ...proposal, edits: [{ before: "original", after: '<img src=x onerror="alert(1)">' }] } });
  await render(); expect(host.querySelector("img")).toBeNull(); await click("agent.reject"); expect(apply).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled();
});
it("a late approval after closing never edits the old note", async () => {
  let resolve!: (value: unknown) => void; mocks.approve.mockImplementation(() => new Promise(r => { resolve = r; }));
  await render(); await click("agent.accept"); act(() => root.render(<div />));
  await act(async () => { resolve(proposal); }); expect(apply).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled();
});
it("offers drafting guidance for an empty note without sending a request on shortcut selection", async () => {
  current = ""; mocks.latest.mockResolvedValue(null);
  await render();
  expect(host.textContent).toContain("agent.guidance.empty.title");
  await click("agent.guidance.empty.actions.draft");
  expect(host.querySelector("textarea")!.value).toBe("agent.guidance.empty.prompts.draft");
  expect(mocks.create).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
});
it("shows pending capability checks as loading rather than disabled", async () => {
  mocks.capabilities.mockReturnValue(new Promise(() => {}));
  await render();
  expect(host.textContent).toContain("agent.loading");
  expect(host.textContent).not.toContain("agent.disabled");
});
it("distinguishes note and selection scope and never labels a running proposal as an empty state", async () => {
  mocks.latest.mockResolvedValue(null); selection = "original";
  await render();
  expect(host.textContent).toContain("agent.scope.selection");
  await click("agent.guidance.selection.actions.polish");
  expect(host.querySelector("textarea")!.value).toBe("agent.guidance.selection.prompts.polish");
  expect(mocks.create).not.toHaveBeenCalled();
  await act(async () => root.render(<div />));
  selection = ""; mocks.latest.mockResolvedValue(run); await render();
  expect(host.textContent).toContain("agent.scope.note");
  expect(host.textContent).not.toContain("agent.guidance.note.title");
});

async function prepareGeneration() {
  mocks.latest.mockResolvedValue(null); mocks.getNote.mockResolvedValue({ version: 1 });
  mocks.create.mockResolvedValue({ id: "run" }); mocks.get.mockResolvedValue(run);
  await render();
  await click("agent.guidance.note.actions.polish");
}
async function chooseSkill(id: string) {
  const select = host.querySelector('select[aria-label="aiCollaboration.chatSkill"]') as HTMLSelectElement;
  await act(async () => { select.value = id; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
it("sends the selected Skill ID with the editor snapshot and keeps the proposal pending approval", async () => {
  await prepareGeneration(); await chooseSkill("review"); await click("agent.generate");
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ noteId: "note", skillId: "review", content: "original", instruction: "agent.guidance.note.prompts.polish", version: 1 }));
  expect(JSON.stringify(mocks.create.mock.calls)).not.toContain("PRIVATE SKILL");
  expect(apply).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled();
  expect(host.textContent).toContain("agent.accept");
});
it("omits the Skill when disabled and clears selection after an account change", async () => {
  await prepareGeneration(); await chooseSkill("review"); await chooseSkill(""); await click("agent.generate");
  expect(mocks.create.mock.calls[0][0].skillId).toBeUndefined();
  await chooseSkill("review"); mocks.scope = "account-b"; mocks.skills.mockResolvedValue({ items: [] });
  await act(async () => window.dispatchEvent(new Event("nowen:token-changed")));
  expect(host.querySelector<HTMLSelectElement>("select")!.value).toBe("");
  expect(host.textContent).not.toContain("Review");
});
it("blocks a late snapshot read after account switch before sending the Skill or note to generation", async () => {
  await prepareGeneration(); await chooseSkill("review");
  let resolve!: (value: unknown) => void; mocks.getNote.mockImplementation(() => new Promise(done => { resolve = done; }));
  await click("agent.generate"); mocks.scope = "account-b";
  await act(async () => resolve({ version: 1 }));
  expect(mocks.create).not.toHaveBeenCalled();
  expect(host.textContent).toContain("aiCollaboration.chatScopeChanged");
});
