import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), current: vi.fn(), t: (key: string) => key }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t, i18n: { language: "en" } }) }));
vi.mock("@/lib/api", () => ({ api: { agentLibrary: { request: mocks.request } } }));
vi.mock("@/lib/taskComposerApi", () => ({ getTaskComposerContext: () => ({}), isTaskComposerContextCurrent: mocks.current }));
import AgentTemplates from "../AgentTemplates";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks(); mocks.current.mockReturnValue(true);
  mocks.request.mockImplementation(async (_workspace, path, method, body) => method === "POST" ? { id: "saved", name: body.name, revision: "revision", config: body } : path === "/prompts" ? [{ id: "prompt", name: "Saved prompt" }] : path === "/prompts/prompt" ? { name: "Copied", instruction: '<script>alert(1)</script>' } : []);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function render() { await act(async () => root.render(<AgentTemplates workspaceId="personal" books={[{ id: "book", name: "Book" }] as never} onUse={vi.fn()} />)); }
async function selectPrompt() { const select = host.querySelector('select[aria-label="agent.templates.fromPrompt"]') as HTMLSelectElement; await act(async () => { select.value = "prompt"; select.dispatchEvent(new Event("change", { bubbles: true })); }); }
it("copies an owned Prompt as text without inheriting note/task/tool permissions", async () => {
  await render(); await selectPrompt();
  expect((host.querySelector('input[aria-label="agent.templates.name"]') as HTMLInputElement).value).toBe("Copied");
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toContain("<script>");
  expect(host.querySelector("script")).toBeNull();
  const checkboxes = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  expect(checkboxes.slice(1).every(box => !box.checked)).toBe(true);
  const save = [...host.querySelectorAll("button")].find(button => button.textContent === "agent.templates.save")!;
  await act(async () => save.click());
  expect(mocks.request).toHaveBeenCalledWith("personal", "/templates", "POST", expect.objectContaining({ allowNote: false, allowTasks: false, toolIds: [], input: expect.objectContaining({ notebookId: "book" }) }));
});
it("late Prompt responses never fill a different profile", async () => {
  await render(); let finish!: (value: unknown) => void;
  mocks.request.mockImplementation((_workspace, path) => path === "/prompts/prompt" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([]));
  const select = host.querySelector('select[aria-label="agent.templates.fromPrompt"]') as HTMLSelectElement;
  await act(async () => { select.value = "prompt"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  mocks.current.mockReturnValue(false);
  await act(async () => finish({ name: "Wrong account", instruction: "Private prompt" }));
  expect((host.querySelector('input[aria-label="agent.templates.name"]') as HTMLInputElement).value).toBe("");
  expect(mocks.request).toHaveBeenCalledTimes(6);
});
