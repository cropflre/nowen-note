import React, { act } from "react";
import JSZip from "jszip";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MigrationHub from "../MigrationHub";
import type { MigrationJob } from "@/lib/migrations";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), create: vi.fn(), upload: vi.fn(), preview: vi.fn(), approve: vi.fn(),
  retry: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), undo: vi.fn(), report: vi.fn(),
  imported: vi.fn(), view: vi.fn(), legacy: vi.fn(), confirm: vi.fn(), items: vi.fn(), decide: vi.fn(), tokens: vi.fn(), clipboard: vi.fn(),
  scope: "server:user-1", openArchive: vi.fn(), archiveOn: false, aiAvailable: true,
}));
vi.mock("@/lib/migrations", async (original) => ({ ...await original<typeof import("@/lib/migrations")>(), migrationApi: { ...mocks, uploadResumable: mocks.upload } }));
vi.mock("@/lib/api", () => ({ api: { getNotebooks: async () => [{ id: "book-1", name: "Work" }], tokens: { list: mocks.tokens } } }));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: () => mocks.scope }));
vi.mock("@/lib/reliableExportDownloadBridge", () => ({ scheduleObjectUrlRevocation: vi.fn() }));
vi.mock("../settings/McpConnectionPanel", () => ({ default: () => <span>Connection guide</span> }));
vi.mock("../ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("@/lib/aiMemory", () => ({ openAIMemory: (...args: unknown[]) => mocks.openArchive(...args) }));
vi.mock("@/hooks/useSiteSettings", () => ({ useSiteSettings: () => ({ siteConfig: { aiMemoryEnabled: mocks.archiveOn } }) }));
vi.mock("@/lib/aiConnection", () => ({ useAIConnectionAvailable: () => mocks.aiAvailable }));
vi.mock("react-i18next", () => { const t = (key: string) => key; return { useTranslation: () => ({ t }) }; });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseJob: MigrationJob = {
  id: "job-1", name: "My notes", source: { platform: "files", exportId: "export-1" }, preparedBy: "user", workspaceId: null,
  status: "PREVIEW_READY", previewDigest: "digest-1", warnings: ["UNSUPPORTED_FILES_SKIPPED; unknown files are not imported"], rootNotebookId: null,
  counts: { total: 2, create: 2, existing: 0, skipped: 0, needsAttention: 0, imported: 0, failed: 0, attachments: 1, bytes: 42 },
  createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z", undo: { available: false, reason: null },
};
const props = { workspaceId: "personal", disabled: false, onImported: mocks.imported, onView: mocks.view, onLegacyImport: mocks.legacy };
let root: Root, host: HTMLElement;
const button = (key: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim().startsWith(`migration.${key}`));
const click = async (node: HTMLElement | undefined) => { if (!node) throw new Error("missing control"); await act(async () => node.click()); };
const render = async (extra: Partial<React.ComponentProps<typeof MigrationHub>> = {}) => {
  await act(async () => root.render(<MigrationHub {...props} {...extra}/>));
};
const openJob = async () => { await click(host.querySelector<HTMLButtonElement>('button[aria-label="migration.selectJob"]')!); };
const pick = async (input: HTMLInputElement, files: File[]) => {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
};
const choose = (files: File[]) => pick(host.querySelector<HTMLInputElement>('input[aria-label="migration.smart.chooseFiles"]')!, files);
const zip = (name: string) => new File(["PK"], name, { type: "application/zip" });
const chatgptExport = async () => {
  const archive = new JSZip(); archive.file("conversations.json", "[]"); archive.file("chat.html", "<html></html>");
  return new File([await archive.generateAsync({ type: "blob" })], "chatgpt-export.zip", { type: "application/zip" });
};

beforeEach(() => {
  vi.clearAllMocks(); mocks.scope = "server:user-1"; mocks.archiveOn = false; mocks.aiAvailable = true;
  mocks.view.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([baseJob]); mocks.get.mockResolvedValue(baseJob);
  mocks.create.mockResolvedValue({ ...baseJob, status: "CREATED", previewDigest: null });
  mocks.upload.mockResolvedValue({ ...baseJob, status: "CREATED", previewDigest: null });
  mocks.preview.mockResolvedValue(baseJob);
  mocks.items.mockResolvedValue({ job: baseJob, items: [], nextCursor: null });
  mocks.decide.mockResolvedValue({ ...baseJob, previewDigest: "digest-2" });
  mocks.approve.mockResolvedValue({ ...baseJob, status: "IMPORTING" });
  mocks.retry.mockResolvedValue({ ...baseJob, status: "IMPORTING" });
  mocks.cancel.mockResolvedValue({ ...baseJob, status: "CANCELLED" });
  mocks.undo.mockResolvedValue({ ...baseJob, status: "UNDONE" });
  mocks.confirm.mockResolvedValue(true);
  mocks.tokens.mockResolvedValue({ tokens: [], availableScopes: [] });
  mocks.clipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.clipboard } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("Import notes: one drop area, one summary, one import button", () => {
  it("hands an AI chat export to the AI conversation archive instead of uploading it as notes", async () => {
    mocks.list.mockResolvedValue([]); mocks.archiveOn = true;
    const exported = await chatgptExport();
    await render(); await choose([exported]);
    await vi.waitFor(() => expect(host.textContent).toContain("migration.smart.chat.title"));
    expect(host.textContent).toContain("migration.smart.chat.hint");
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
    await click(button("smart.chat.toArchive"));
    expect(mocks.openArchive).toHaveBeenCalledWith("connections", { file: exported, provider: "chatgpt" });
    expect(host.querySelector("[data-import-drop-zone]")).not.toBeNull();
  });

  it("with the archive switched off, says so and can still import the export as ordinary notes", async () => {
    mocks.list.mockResolvedValue([]);
    await render(); await choose([await chatgptExport()]);
    await vi.waitFor(() => expect(host.textContent).toContain("migration.smart.chat.off"));
    expect(button("smart.chat.toArchive")).toBeUndefined();
    await click(button("smart.chat.asNotes"));
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.openArchive).not.toHaveBeenCalled();
  });

  it("keeps ordinary import available while the AI connection is unverified", async () => {
    mocks.list.mockResolvedValue([]); mocks.archiveOn = true; mocks.aiAvailable = false;
    await render();
    expect(host.querySelector("[data-import-drop-zone]")).not.toBeNull();
    expect(button("smart.assistantLink")).toBeUndefined();
    await choose([await chatgptExport()]);
    await vi.waitFor(() => expect(button("smart.chat.asNotes")).toBeDefined());
    expect(button("smart.chat.toArchive")).toBeUndefined();
  });

  it("starts with a single drop area and keeps AI and technical settings out of the way", async () => {
    mocks.list.mockResolvedValue([]);
    await render();
    expect(host.querySelector("[data-import-drop-zone]")).not.toBeNull();
    expect(host.textContent).toContain("migration.smart.assistantLink");
    expect(host.textContent).not.toContain("migration.client");
    expect(host.querySelector("select")).toBeNull();
    await click(button("smart.changeLocation"));
    expect(host.querySelector("select")?.textContent).toContain("migration.smart.locationNew");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("uploads loose notes as one package so their links survive, previews once, and never imports by itself", async () => {
    await render(); await choose([new File(["# A\n[B](b.html)"], "a.md"), new File(["<p>B</p>"], "b.html")]);
    // Packing the ZIP runs on timers, so wait for the chain to reach the preview.
    await act(async () => { await vi.waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1), { timeout: 5000 }); });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ name: "migration.defaultName", source: { platform: "files" }, workspaceId: "personal" });
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload.mock.calls[0][1].name).toBe("migration.defaultName.zip");
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(mocks.preview).toHaveBeenCalledWith("job-1");
    expect(host.textContent).toContain("migration.smart.found");
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("sends an export ZIP as it is and names the import after it", async () => {
    const exported = zip("Notion Export.zip");
    await render(); await choose([exported]);
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ name: "Notion Export" });
    expect(mocks.upload.mock.calls[0][1]).toBe(exported);
  });

  it("explains selections it cannot import without contacting the server", async () => {
    await render(); await choose([new File(["PNG"], "photo.png")]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("migration.smart.errors.no-notes");
    await choose([new File(["x"], "Notes.enex")]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("migration.smart.errors.unsupported-files");
    await click(button("smart.useAssistant"));
    expect(host.textContent).toContain("migration.smart.assistant.copy");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("treats the summary as the review: importing takes the explicit import button and the current preview", async () => {
    await render(); await openJob();
    expect(host.textContent).toContain("migration.smart.found");
    expect(host.textContent).toContain("migration.smart.risks.unsupported");
    expect(mocks.approve).not.toHaveBeenCalled();
    await click(button("smart.importCount"));
    expect(mocks.approve).toHaveBeenCalledTimes(1);
    expect(mocks.approve).toHaveBeenCalledWith("job-1", "digest-1");
    expect(host.textContent).toContain("migration.smart.importing");
  });

  it("blocks importing until changed notes are decided, and a decision never imports by itself", async () => {
    const attention = { ...baseJob, counts: { ...baseJob.counts, existing: 1, needsAttention: 1 } };
    mocks.get.mockResolvedValue(attention);
    mocks.items.mockResolvedValue({ job: attention, items: [{ id: "item-1", sourceId: "source-1", title: "Changed note", path: [], status: "ATTENTION", action: "existing", decision: "auto", warnings: [] }], nextCursor: null });
    await render(); await openJob();
    expect(host.textContent).toContain("migration.smart.existing");
    expect(host.textContent).toContain("migration.smart.attention");
    expect(button("smart.importCount")!.disabled).toBe(true);
    await click(button("smart.details"));
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="migration.itemDecision"]')!;
    await act(async () => { select.value = "create-copy"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(mocks.decide).toHaveBeenCalledWith("job-1", "item-1", "digest-1", "create-copy");
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("keeps the preview after a stale import and asks to check again", async () => {
    await render(); await openJob();
    mocks.approve.mockRejectedValueOnce(Object.assign(new Error("预览已过期"), { code: "MIGRATION_PREVIEW_EXPIRED", status: 409 }));
    await click(button("smart.importCount"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("migration.smart.errors.changed");
    expect(host.textContent).not.toContain("预览已过期");
    mocks.preview.mockResolvedValueOnce({ ...baseJob, previewDigest: "digest-2" });
    await click(button("smart.recheck"));
    expect(mocks.preview).toHaveBeenCalledWith("job-1");
    expect(mocks.approve).toHaveBeenCalledTimes(1);
  });

  it("reopens partial results, retries failures, opens the notes and checks before undo", async () => {
    const partial: MigrationJob = { ...baseJob, status: "PARTIAL", rootNotebookId: "root-1", counts: { ...baseJob.counts, imported: 1, failed: 1 }, undo: { available: true, reason: null } };
    mocks.list.mockResolvedValue([partial]); mocks.get.mockResolvedValue(partial);
    await render(); await openJob();
    expect(mocks.imported).toHaveBeenCalledWith(partial);
    await click(button("smart.viewNotes")); expect(mocks.view).toHaveBeenCalledWith(partial);
    await click(button("undo")); expect(mocks.confirm).toHaveBeenCalledTimes(1); expect(mocks.undo).toHaveBeenCalledWith("job-1");
    // After undo the result offers a fresh start; the partial job can be reopened from the history.
    mocks.get.mockResolvedValue(partial); await click(button("smart.startOver")); await openJob();
    await click(button("smart.retryFailed")); expect(mocks.retry).toHaveBeenCalledWith("job-1");
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("shows a finished import plainly, with the way to the notes", async () => {
    const done: MigrationJob = { ...baseJob, status: "COMPLETED", rootNotebookId: "root-1", counts: { ...baseJob.counts, imported: 2 }, undo: { available: true, reason: null } };
    mocks.get.mockResolvedValue(done);
    await render(); await openJob();
    expect(host.textContent).toContain("migration.smart.done");
    expect(host.textContent).not.toContain("root-1");
    await click(button("smart.viewNotes")); expect(mocks.view).toHaveBeenCalledWith(done);
  });

  it("turns a failed check into a friendly message with a way forward", async () => {
    mocks.upload.mockResolvedValueOnce({ ...baseJob, status: "FAILED", previewDigest: null, error: "MIGRATION_INVALID_ZIP" });
    await render(); await choose([zip("broken.zip")]);
    // One explanation, in the failed import's own card, with no error code.
    const alerts = Array.from(host.querySelectorAll('[role="alert"]'), (node) => node.textContent);
    expect(alerts).toEqual(["migration.smart.errors.format"]);
    expect(host.textContent).toContain("migration.smart.failedTitle");
    expect(host.textContent).not.toContain("MIGRATION_INVALID_ZIP");
    expect(button("smart.startOver")).toBeDefined();
    expect(mocks.preview).not.toHaveBeenCalled();
    // Letting AI help leaves the failed import behind and opens the assistant path.
    await click(button("smart.useAssistant"));
    expect(host.textContent).toContain("migration.smart.assistant.copy");
    expect(host.textContent).not.toContain("migration.smart.failedTitle");
  });

  it("continues an interrupted upload in the same job", async () => {
    mocks.get.mockResolvedValue({ ...baseJob, status: "CREATED", previewDigest: null });
    await render(); await openJob();
    expect(host.textContent).toContain("migration.smart.incompleteTitle");
    await pick(host.querySelector<HTMLInputElement>('input[aria-label="migration.smart.resume"]')!, [zip("Export.zip")]);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.upload.mock.calls[0][0]).toBe("job-1");
    expect(mocks.preview).toHaveBeenCalledWith("job-1");
  });

  it("stops the remaining uploads when the account changes", async () => {
    await render();
    mocks.upload.mockImplementationOnce(async () => { mocks.scope = "server:user-2"; return { ...baseJob, status: "CREATED" }; });
    await choose([zip("a.zip"), zip("b.zip")]);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("waits for the server to check each file before sending the next", async () => {
    vi.useFakeTimers();
    mocks.upload.mockResolvedValueOnce({ ...baseJob, status: "SCANNING" });
    mocks.get.mockResolvedValueOnce({ ...baseJob, status: "CREATED" });
    await render(); await choose([zip("a.zip"), zip("b.zip")]);
    expect(mocks.upload).toHaveBeenCalledTimes(1); expect(mocks.preview).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mocks.upload).toHaveBeenCalledTimes(2); expect(mocks.preview).toHaveBeenCalledWith("job-1");
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("explains device-only limits and keeps the other import entry without calling the server", async () => {
    await render({ localOnly: true });
    expect(host.textContent).toContain("migration.localOnly");
    expect(host.querySelector("[data-import-drop-zone]")).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
    await click(button("smart.otherFormats")); expect(mocks.legacy).toHaveBeenCalledTimes(1);
  });
});

describe("Let AI move it: only what the server actually knows", () => {
  it("offers the instruction without claiming a connection when no import token has been used", async () => {
    mocks.list.mockResolvedValue([]);
    await render(); await click(button("smart.assistantLink"));
    expect(host.textContent).toContain("migration.smart.assistant.title");
    expect(host.textContent).not.toContain("migration.smart.assistant.connected");
    await click(button("smart.assistant.copy"));
    expect(mocks.clipboard).toHaveBeenCalledWith("migration.prompt");
    expect(host.textContent).toContain("migration.smart.assistant.copied");
  });

  it("says connected after an import token was used, and opens a job the assistant prepared for review", async () => {
    const prepared: MigrationJob = { ...baseJob, id: "job-ai", preparedBy: "assistant" };
    mocks.list.mockResolvedValue([prepared]); mocks.get.mockResolvedValue(prepared);
    mocks.tokens.mockResolvedValue({ tokens: [{ id: "t", name: "Codex", scopes: ["export:import"], expiresAt: null, lastUsedAt: "2026-11-15T08:00:00Z", lastUsedIp: null, createdAt: "2026-11-01T00:00:00Z", revokedAt: null }], availableScopes: [] });
    await render(); await click(button("smart.assistantLink"));
    expect(host.textContent).toContain("migration.smart.assistant.connected");
    expect(host.textContent).toContain("migration.smart.assistant.ready");
    await click(button("smart.assistant.review"));
    expect(mocks.get).toHaveBeenCalledWith("job-ai");
    expect(host.textContent).toContain("migration.smart.preparedByAssistant");
    expect(mocks.approve).not.toHaveBeenCalled();
  });
});
