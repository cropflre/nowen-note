import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import AIMemoryHub from "../AIMemoryHub";
import type { AIImportJob } from "@/lib/aiMemory";
const mocks = vi.hoisted(() => ({ createNotebook: vi.fn(), sources: vi.fn(), conversations: vi.fn(), imports: vi.fn(), previewImport: vi.fn(), startImport: vi.fn(), importJob: vi.fn(), cancelImport: vi.fn(), retryImport: vi.fn(), discardImport: vi.fn(), createSource: vi.fn(), updateSource: vi.fn(), revokeSource: vi.fn(), messages: vi.fn(), deleteConversation: vi.fn(), restoreConversation: vi.fn(), rebuildNote: vi.fn(), confirm: vi.fn(), scope: "server:user", local: false }));
vi.mock("@/lib/aiMemory", () => ({ aiMemoryApi: mocks }));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: () => mocks.scope }));
vi.mock("@/lib/api", () => ({ api: { getNotebooks: async () => [{ id: "book", name: "Personal", workspaceId: null }], createNotebook: (data: unknown) => mocks.createNotebook(data) }, setCurrentWorkspace: vi.fn() }));
vi.mock("@/lib/workspaceRefreshBridge", () => ({ emitKnowledgeTreeRefresh: vi.fn() }));
vi.mock("@/lib/mobileLocalMode", () => ({ isMobileLocalMode: () => mocks.local }));
vi.mock("@/lib/noteDeepLink", () => ({ pushNoteAppPath: vi.fn() }));
vi.mock("@/lib/reliableExportDownloadBridge", () => ({ scheduleObjectUrlRevocation: vi.fn() }));
vi.mock("../ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, host: HTMLElement;
const source = { id: "source", provider: "chatgpt", accountScope: "account", notebookId: "book", displayName: "My ChatGPT", captureEnabled: false, permissionState: "granted", lastSyncedAt: null };
const job: AIImportJob = { id: "job", sourceId: "source", filename: "export.zip", status: "PREVIEW", previewDigest: "digest", expiresAt: "2026-11-06T00:00:00Z", warnings: ["Incomplete attachments"], counts: { total: 1, saved: 0, failed: 0, pending: 1, skipped: 0 }, items: [{ index: 0, title: "Project", messages: 2, completeness: "partial", expectedRevision: 0, status: "pending", preview: "<script>neverExecute()</script>" }] };
const button = (key: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes(`aiMemory.${key}`))!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const change = async (element: HTMLInputElement | HTMLSelectElement, value: string) => { await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); }); };
const render = async (tab: "archive" | "connections" = "archive") => { await act(async () => root.render(<AIMemoryHub scope="server:user" initialTab={tab}/>)); };
beforeEach(() => {
  vi.clearAllMocks(); mocks.scope = "server:user"; mocks.local = false;
  mocks.sources.mockResolvedValue([source]); mocks.conversations.mockResolvedValue({ items: [], total: 0 }); mocks.imports.mockResolvedValue([]);
  mocks.previewImport.mockResolvedValue(job); mocks.startImport.mockResolvedValue({ ...job, status: "IMPORTING" }); mocks.importJob.mockResolvedValue(job);
  mocks.createSource.mockResolvedValue(source); mocks.confirm.mockResolvedValue(true);
  mocks.createNotebook.mockImplementation(async (data: { name: string }) => ({ id: "ai-book", name: data.name, workspaceId: null, parentId: null }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
describe("AI memory archive and import workflow", () => {
  it("offers only what exists: the archive and its connections, no placeholder tab", async () => {
    await render();
    expect([...host.querySelectorAll("nav button")].map(item => item.textContent)).toEqual(["aiMemory.archive", "aiMemory.connections"]);
    expect(mocks.startImport).not.toHaveBeenCalled();
  });
  it("requires explicit review after parsing and renders untrusted previews as text", async () => {
    await render("connections");
    await change(host.querySelector('select[aria-label="aiMemory.chooseSource"]')!, "source");
    const field = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(field, "files", { configurable: true, value: [new File(["ZIP"], "export.zip")] });
    await act(async () => field.dispatchEvent(new Event("change", { bubbles: true })));
    expect(mocks.previewImport).toHaveBeenCalledTimes(1); expect(mocks.startImport).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Incomplete attachments"); expect(host.textContent).toContain("<script>neverExecute()</script>"); expect(host.querySelector("script")).toBeNull();
    expect(button("start").disabled).toBe(true);
    await click(host.querySelector<HTMLInputElement>('section[aria-label="export.zip"] input[type="checkbox"]')!);
    await click(button("start")); expect(mocks.startImport).toHaveBeenCalledWith(job);
  });
  it("does not create an import source without consent and a selected notebook", async () => {
    await render("connections"); expect(button("create").disabled).toBe(true);
    const form = host.querySelector("details form")!;
    const selects = form.querySelectorAll("select"); await change(selects[1], "book");
    expect(button("create").disabled).toBe(true);
    await click(form.querySelector<HTMLInputElement>('input[type="checkbox"]')!); expect(button("create").disabled).toBe(false);
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.createSource.mock.calls[0][0]).toMatchObject({ notebookId: "book", captureEnabled: false, permissionState: "granted" });
  });
  it("uses the AI conversations notebook when no notebook is chosen, creating it only once", async () => {
    await render("connections");
    const form = host.querySelector("details form")!;
    for (let time = 0; time < 2; time++) {
      await click(form.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
      expect(button("create").disabled).toBe(false);
      await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    }
    expect(mocks.createNotebook).toHaveBeenCalledTimes(1);
    expect(mocks.createNotebook).toHaveBeenCalledWith({ name: "aiMemory.defaultNotebook", workspaceId: null });
    expect(mocks.createSource.mock.calls.map(call => call[0].notebookId)).toEqual(["ai-book", "ai-book"]);
    expect(mocks.createSource.mock.calls[0][0]).toMatchObject({ provider: "chatgpt", displayName: "ChatGPT" });
  });
  it("creates an AI assistant source with its own consent, kept out of file imports", async () => {
    mocks.sources.mockResolvedValue([source, { ...source, id: "assistant", accountScope: "mcp:claude", provider: "standard", displayName: "Claude Code" }]);
    await render("connections");
    expect([...host.querySelectorAll<HTMLOptionElement>('select[aria-label="aiMemory.chooseSource"] option')].map(option => option.value)).toEqual(["", "source"]);
    expect(host.textContent).toContain("Claude Code · aiMemory.assistantSource");
    expect(host.textContent).toContain("My ChatGPT · chatgpt");
    const form = host.querySelector("details form")!;
    const [kind, notebook] = form.querySelectorAll("select");
    await change(notebook, "book");
    await click(form.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    // Switching to an assistant source asks for consent again, with wording about MCP.
    await change(kind, "assistant");
    expect(form.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(form.textContent).toContain("aiMemory.assistantConsent");
    await click(form.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.createSource.mock.calls[0][0]).toMatchObject({ provider: "standard", notebookId: "book", displayName: "aiMemory.assistantSource", captureEnabled: false, permissionState: "granted" });
    expect(mocks.createSource.mock.calls[0][0].accountScope).toMatch(/^mcp:/);
  });
  it("previews a file handed over from Import notes with the only fitting import source", async () => {
    mocks.sources.mockResolvedValue([source, { ...source, id: "import-source", accountScope: "import:chatgpt" }]);
    const file = new File(["{}"], "export.zip");
    await act(async () => root.render(<AIMemoryHub scope="server:user" initialTab="connections" importFile={{ file, provider: "chatgpt" }}/>));
    await vi.waitFor(() => expect(mocks.previewImport).toHaveBeenCalledWith("import-source", file, expect.anything()));
  });
  it("keeps a handed-over file until a fitting source is created, then previews it", async () => {
    const created = { ...source, id: "new-import", accountScope: "import:new" };
    mocks.createSource.mockResolvedValue(created);
    const file = new File(["{}"], "export.zip");
    await act(async () => root.render(<AIMemoryHub scope="server:user" initialTab="connections" importFile={{ file, provider: "chatgpt" }}/>));
    expect(host.textContent).toContain("aiMemory.pendingFile");
    expect(mocks.previewImport).not.toHaveBeenCalled();
    mocks.sources.mockResolvedValue([source, created]);
    const form = host.querySelector("details form")!;
    await click(form.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(mocks.previewImport).toHaveBeenCalledWith("new-import", file, expect.anything()));
    expect(host.textContent).not.toContain("aiMemory.pendingFile");
  });
  it("ignores late import responses after an account switch", async () => {
    let resolve!: (value: AIImportJob) => void; mocks.previewImport.mockReturnValue(new Promise(value => { resolve = value; }));
    await render("connections"); await change(host.querySelector('select[aria-label="aiMemory.chooseSource"]')!, "source");
    const field = host.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(field, "files", { value: [new File(["ZIP"], "export.zip")] });
    await act(async () => field.dispatchEvent(new Event("change", { bubbles: true })));
    mocks.scope = "different:user"; await act(async () => resolve(job));
    expect(host.querySelector('section[aria-label="export.zip"]')).toBeNull(); expect(mocks.startImport).not.toHaveBeenCalled();
  });
  it("does not contact archive APIs in device-only mode", async () => {
    mocks.local = true; await render(); expect(host.textContent).toContain("aiMemory.deviceOnly"); expect(mocks.sources).not.toHaveBeenCalled(); expect(mocks.conversations).not.toHaveBeenCalled();
  });
});
