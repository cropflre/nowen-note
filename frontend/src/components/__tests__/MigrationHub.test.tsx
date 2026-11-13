import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MigrationHub from "../MigrationHub";
import type { MigrationJob } from "@/lib/migrations";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), create: vi.fn(), upload: vi.fn(), preview: vi.fn(), approve: vi.fn(),
  retry: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), undo: vi.fn(), report: vi.fn(),
  imported: vi.fn(), view: vi.fn(), legacy: vi.fn(), confirm: vi.fn(), items: vi.fn(), decide: vi.fn(), scope: "server:user-1",
}));
vi.mock("@/lib/migrations", async (original) => ({ ...await original<typeof import("@/lib/migrations")>(), migrationApi: { ...mocks, uploadResumable: mocks.upload } }));
vi.mock("@/lib/api", () => ({ api: { getNotebooks: async () => [{ id: "book-1", name: "Work" }] } }));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: () => mocks.scope }));
vi.mock("@/lib/reliableExportDownloadBridge", () => ({ scheduleObjectUrlRevocation: vi.fn() }));
vi.mock("../settings/McpConnectionPanel", () => ({ default: () => <span>Connection guide</span> }));
vi.mock("../ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("react-i18next", () => { const t = (key: string) => key; return { useTranslation: () => ({ t }) }; });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseJob: MigrationJob = {
  id: "job-1", name: "My notes", source: { platform: "files", exportId: "export-1" }, workspaceId: null,
  status: "PREVIEW_READY", previewDigest: "digest-1", warnings: ["One unsupported field"], rootNotebookId: null,
  counts: { total: 2, create: 2, existing: 0, skipped: 0, needsAttention: 0, imported: 0, failed: 0, attachments: 1, bytes: 42 },
  createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z", undo: { available: false, reason: null },
};
const props = { workspaceId: "personal", disabled: false, onImported: mocks.imported, onView: mocks.view, onLegacyImport: mocks.legacy };
let root: Root, host: HTMLElement;
const button = (key: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.startsWith(`migration.${key}`))!;
const click = async (node: HTMLElement) => { await act(async () => node.click()); };
const render = async (extra: Partial<React.ComponentProps<typeof MigrationHub>> = {}) => {
  await act(async () => root.render(<MigrationHub {...props} {...extra}/>));
};
const openJob = async () => { await click(host.querySelector<HTMLButtonElement>('button[aria-label="migration.selectJob"]')!); };
const choose = async (files = [new File(["A"], "a.md"), new File(["B"], "b.html")]) => {
  await click(button("files"));
  const field = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(field, "files", { configurable: true, value: files });
  await act(async () => field.dispatchEvent(new Event("change", { bubbles: true })));
};

beforeEach(() => {
  vi.clearAllMocks(); mocks.scope = "server:user-1";
  mocks.view.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([baseJob]); mocks.get.mockResolvedValue(baseJob);
  mocks.create.mockResolvedValue({ ...baseJob, status: "CREATED", previewDigest: null });
  mocks.upload.mockResolvedValue({ ...baseJob, status: "CREATED", previewDigest: null });
  mocks.preview.mockResolvedValue(baseJob);
  mocks.items.mockResolvedValue({ job: baseJob, items: [], nextCursor: null });
  mocks.decide.mockResolvedValue({ ...baseJob, previewDigest: "digest-2" });
  mocks.approve.mockResolvedValue({ ...baseJob, status: "IMPORTING" });
  mocks.retry.mockResolvedValue({ ...baseJob, status: "IMPORTING" });
  mocks.undo.mockResolvedValue({ ...baseJob, status: "UNDONE" });
  mocks.confirm.mockResolvedValue(true);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("Migration Hub review and job lifecycle", () => {
  it("blocks unresolved source changes and requires another review after an item decision", async () => {
    const attention = { ...baseJob, counts: { ...baseJob.counts, needsAttention: 1 } };
    mocks.get.mockResolvedValue(attention);
    mocks.items.mockResolvedValue({ job: attention, items: [{ id: "item-1", sourceId: "source-1", title: "Changed note", path: [], status: "ATTENTION", action: "existing", decision: "auto", warnings: [] }], nextCursor: null });
    await render(); await openJob();
    await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(button("approve").disabled).toBe(true);
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="migration.itemDecision"]')!;
    await act(async () => { select.value = "create-copy"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(mocks.decide).toHaveBeenCalledWith("job-1", "item-1", "digest-1", "create-copy");
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it("loads AI-prepared jobs and requires a real review action before approval", async () => {
    await render();
    expect(host.textContent).toContain("migration.ai"); expect(host.textContent).toContain("migration.files");
    await openJob();
    expect(host.textContent).toContain("One unsupported field");
    expect(button("approve").disabled).toBe(true);
    expect(mocks.approve).not.toHaveBeenCalled();
    await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(button("approve"));
    expect(mocks.approve).toHaveBeenCalledTimes(1);
    expect(mocks.approve).toHaveBeenCalledWith("job-1", "digest-1");
    expect(host.textContent).toContain("migration.states.IMPORTING");
  });

  it("uploads multiple files sequentially, previews once, and does not import automatically", async () => {
    await render(); await choose();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ source: { platform: "files" }, workspaceId: "personal" });
    expect(mocks.upload.mock.calls.map((call) => call[1].name)).toEqual(["a.md", "b.html"]);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(mocks.preview).toHaveBeenCalledWith("job-1");
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(button("approve").disabled).toBe(true);
  });

  it("clears a cancelled resume selection when the user chooses a new migration file", async () => {
    mocks.get.mockResolvedValue({ ...baseJob, status: "CREATED", previewDigest: null });
    await render(); await openJob(); await click(button("continueUpload"));
    await click([...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "migration.choose")!);
    const field = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(field, "files", { configurable: true, value: [new File(["A"], "a.md")] });
    await act(async () => field.dispatchEvent(new Event("change", { bubbles: true })));
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("keeps a stale preview visible after rejection and makes the user review a refreshed digest", async () => {
    await render(); await openJob();
    await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    mocks.approve.mockRejectedValueOnce(new Error("Preview changed"));
    await click(button("approve"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Preview changed");
    mocks.get.mockResolvedValueOnce({ ...baseJob, previewDigest: "digest-2" });
    await openJob();
    expect(button("approve").disabled).toBe(true);
    expect(mocks.approve).toHaveBeenCalledTimes(1);
  });

  it("reopens persisted partial results, retries failures, and checks before undo", async () => {
    const partial: MigrationJob = { ...baseJob, status: "PARTIAL", rootNotebookId: "root-1", counts: { ...baseJob.counts, imported: 1, failed: 1 }, undo: { available: true, reason: null } };
    mocks.list.mockResolvedValue([partial]); mocks.get.mockResolvedValue(partial);
    await render(); await openJob();
    expect(mocks.imported).toHaveBeenCalledWith(partial);
    await click(button("view")); expect(mocks.view).toHaveBeenCalledWith(partial);
    await click(button("undo")); expect(mocks.confirm).toHaveBeenCalledTimes(1); expect(mocks.undo).toHaveBeenCalledWith("job-1");
    mocks.get.mockResolvedValue(partial); await openJob();
    await click(button("retry")); expect(mocks.retry).toHaveBeenCalledTimes(1); expect(mocks.retry).toHaveBeenCalledWith("job-1");
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("stops the remaining upload chain when the account changes", async () => {
    await render();
    mocks.upload.mockImplementationOnce(async () => { mocks.scope = "server:user-2"; return { ...baseJob, status: "CREATED" }; });
    await choose();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("waits for background scanning before uploading the next file", async () => {
    vi.useFakeTimers();
    mocks.upload.mockResolvedValueOnce({ ...baseJob, status: "SCANNING" });
    mocks.get.mockResolvedValueOnce({ ...baseJob, status: "CREATED" });
    await render(); await choose();
    expect(mocks.upload).toHaveBeenCalledTimes(1); expect(mocks.preview).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mocks.upload).toHaveBeenCalledTimes(2); expect(mocks.preview).toHaveBeenCalledWith("job-1");
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("explains device-only limits and keeps the existing import entry without calling the server", async () => {
    await render({ localOnly: true });
    expect(host.textContent).toContain("migration.localOnly");
    expect(mocks.list).not.toHaveBeenCalled(); expect(button("files")).toBeUndefined();
    await click(button("legacy")); expect(mocks.legacy).toHaveBeenCalledTimes(1);
  });
});
