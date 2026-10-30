import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskComposer from "../TaskComposer";
import { enTaskComposerTranslations, zhCNTaskComposerTranslations } from "@/i18n/taskComposerTranslations";
import { confirm } from "../../ui/confirm";
import { confirmTaskComposition, previewTaskComposition, TaskComposerApiError, type TaskCandidate } from "@/lib/taskComposerApi";

const mocks = vi.hoisted(() => ({ current: true, language: "en" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: mocks.language }, t: (key: string, options: Record<string, unknown> = {}) => {
  let value: unknown = mocks.language === "en" ? enTaskComposerTranslations : zhCNTaskComposerTranslations;
  for (const part of key.split(".")) value = (value as Record<string, unknown>)?.[part];
  return typeof value === "string" ? value.replace(/{{(\w+)}}/g, (_, name) => String(options[name] ?? "")) : options.defaultValue || key;
} }) }));
vi.mock("../../ui/confirm", () => ({ confirm: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/taskComposerApi", async () => ({
  ...await vi.importActual<typeof import("@/lib/taskComposerApi")>("@/lib/taskComposerApi"),
  getTaskComposerContext: () => ({ baseUrl: "/api", workspaceId: "personal", scopeKey: "composer-test" }),
  isTaskComposerContextCurrent: () => mocks.current,
  previewTaskComposition: vi.fn(), confirmTaskComposition: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const candidate = (title: string, id: string, patch: Partial<TaskCandidate> = {}): TaskCandidate => ({ clientId: id, title, description: "", priority: 2, startDate: null, dueDate: null, dueAt: null, projectId: null, repeatRule: "none", repeatInterval: 1, repeatEndDate: null, repeatEndCount: null, reason: "User supplied", warnings: [], duplicateOf: [], selected: true, allowDuplicate: false, ...patch });
const close = vi.fn(), created = vi.fn(), view = vi.fn();
let root: Root, host: HTMLDivElement;
function button(text: string) { return Array.from(document.querySelectorAll("button")).find(element => element.textContent === text)!; }
async function click(text: string) { await act(async () => { button(text).click(); }); }
async function fill(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function generate() { await fill(document.querySelector("textarea")!, "Tomorrow review notes and fix the bug"); await click("Generate tasks"); }
beforeEach(async () => {
  vi.clearAllMocks(); sessionStorage.clear(); mocks.current = true; mocks.language = "en";
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(previewTaskComposition).mockResolvedValue({ previewId: "preview-1", timezone: "Asia/Shanghai", tasks: [candidate("Review notes", "a"), candidate("Fix bug", "b")], warnings: [] });
  vi.mocked(confirmTaskComposition).mockResolvedValue({ tasks: [], createdCount: 2, replayed: false });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<TaskComposer projects={[]} initialProjectId={null} onClose={close} onCreated={created} onView={view} />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

describe("AI Task Composer", () => {
  it("previews without writes and creates only selected, edited candidates", async () => {
    await generate(); expect(confirmTaskComposition).not.toHaveBeenCalled();
    await fill(document.querySelector<HTMLInputElement>("[aria-label='Task title 1']")!, "Edited title");
    await act(async () => document.querySelector<HTMLInputElement>("[aria-label='Select task 2']")!.click());
    vi.mocked(confirmTaskComposition).mockResolvedValue({ tasks: [], createdCount: 1, replayed: false });
    await click("Create 1 tasks");
    const batch = vi.mocked(confirmTaskComposition).mock.calls[0][1];
    expect(batch.tasks).toHaveLength(1); expect(batch.tasks[0].title).toBe("Edited title"); expect(batch.tasks[0]).not.toHaveProperty("reason");
    expect(created).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain("Created 1 tasks.");
    await click("View today's tasks"); expect(view).toHaveBeenCalledWith("today");
  });
  it("closing a preview never creates tasks and retains the scoped draft", async () => {
    await generate(); await act(async () => document.querySelector<HTMLButtonElement>("[aria-label='Close']")!.click()); expect(close).toHaveBeenCalledOnce(); expect(confirmTaskComposition).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem("composer-test")!).text).toContain("Tomorrow");
  });
  it("disables confirmation with no selected tasks, supports deletion and manual tasks", async () => {
    await generate(); await click("Deselect all"); expect(button("Create 0 tasks").disabled).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>("[aria-label='Remove candidate 1']")!.click());
    await click("Add task"); await fill(document.querySelector<HTMLInputElement>("[aria-label='Task title 2']")!, "Manual task");
    await click("Create 1 tasks"); expect(vi.mocked(confirmTaskComposition).mock.calls[0][1].tasks[0].title).toBe("Manual task");
  });
  it("requires an explicit duplicate override", async () => {
    vi.mocked(previewTaskComposition).mockResolvedValue({ previewId: "p", timezone: "UTC", tasks: [candidate("Duplicate", "a", { duplicateOf: ["existing"], warnings: ["POSSIBLE_DUPLICATE"] })], warnings: [] });
    await generate(); expect(button("Create 0 tasks").disabled).toBe(true);
    await act(async () => document.querySelector<HTMLInputElement>("[aria-label='Create this duplicate anyway 1']")!.click());
    await click("Create 1 tasks"); expect(vi.mocked(confirmTaskComposition).mock.calls[0][1].tasks[0].allowDuplicate).toBe(true);
  });
  it("keeps edits when regeneration is declined or generation fails", async () => {
    await generate(); await fill(document.querySelector<HTMLInputElement>("[aria-label='Task title 1']")!, "Keep edit");
    vi.mocked(confirm).mockResolvedValue(false); await click("Generate again"); expect(previewTaskComposition).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLInputElement>("[aria-label='Task title 1']")!.value).toBe("Keep edit");
    vi.mocked(confirm).mockResolvedValue(true); vi.mocked(previewTaskComposition).mockRejectedValue(new TaskComposerApiError("AI_INVALID_JSON"));
    await click("Generate again"); expect(document.querySelector<HTMLInputElement>("[aria-label='Task title 1']")!.value).toBe("Keep edit"); expect(document.querySelector("[role='alert']")!.textContent).toContain("invalid JSON");
  });
  it("cancels generation and ignores late results", async () => {
    let finish!: (value: Awaited<ReturnType<typeof previewTaskComposition>>) => void;
    vi.mocked(previewTaskComposition).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await generate(); const signal = vi.mocked(previewTaskComposition).mock.calls[0][2];
    await click("Cancel generation"); expect(signal.aborted).toBe(true);
    await act(async () => finish({ previewId: "late", timezone: "UTC", tasks: [candidate("Late", "a")], warnings: [] }));
    expect(document.querySelector("[aria-label='Task title 1']")).toBeNull(); expect(document.querySelector("textarea")!.value).toContain("Tomorrow");
  });
  it("freezes uncertain submissions and retries the identical payload", async () => {
    await generate(); vi.mocked(confirmTaskComposition).mockRejectedValueOnce(new Error("network lost"));
    await click("Create 2 tasks"); expect(created).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain("Created 2 tasks.");
    expect(document.querySelector<HTMLInputElement>("[aria-label='Task title 1']")!.matches(":disabled")).toBe(true);
    const first = vi.mocked(confirmTaskComposition).mock.calls[0][1];
    await click("Retry confirmation"); expect(vi.mocked(confirmTaskComposition).mock.calls[1][1]).toEqual(first); expect(created).toHaveBeenCalledOnce();
  });
  it("blocks rapid confirmation clicks while the request is running", async () => {
    await generate(); let finish!: (result: Awaited<ReturnType<typeof confirmTaskComposition>>) => void;
    vi.mocked(confirmTaskComposition).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const submit = button("Create 2 tasks"); await act(async () => { submit.click(); submit.click(); }); expect(confirmTaskComposition).toHaveBeenCalledOnce();
    await act(async () => finish({ tasks: [], createdCount: 2, replayed: false }));
  });
  it("rejects late generation results after a workspace/account change", async () => {
    let finish!: (result: Awaited<ReturnType<typeof previewTaskComposition>>) => void;
    vi.mocked(previewTaskComposition).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await generate(); mocks.current = false;
    await act(async () => window.dispatchEvent(new Event("nowen:workspace-changed"))); expect(close).toHaveBeenCalledOnce();
    await act(async () => finish({ previewId: "late", timezone: "UTC", tasks: [candidate("Private", "a")], warnings: [] }));
    expect(document.body.textContent).not.toContain("Private");
  });
  it("renders model HTML as text, and English and Chinese have matching keys", async () => {
    vi.mocked(previewTaskComposition).mockResolvedValue({ previewId: "p", timezone: "UTC", tasks: [candidate("<img src=x onerror=alert(1)>", "a", { reason: "<script>alert(1)</script>" })], warnings: [] });
    await generate(); expect(document.querySelector("script, img")).toBeNull();
    const keys = (object: object, prefix = ""): string[] => Object.entries(object).flatMap(([key, value]) => typeof value === "object" ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`]);
    expect(keys(enTaskComposerTranslations)).toEqual(keys(zhCNTaskComposerTranslations));
  });
});
