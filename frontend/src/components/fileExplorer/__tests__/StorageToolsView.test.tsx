import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import StorageToolsView from "../StorageToolsView";
import { sameCleanupPreview, summarizeCleanup } from "@/lib/filePageViews";

const state = vi.hoisted(() => ({ stats: vi.fn(), cleanup: vi.fn(), getMe: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init() {} },
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options ? `${key}|${JSON.stringify(options)}` : key }),
}));
vi.mock("@/lib/api", () => ({ api: { getMe: state.getMe, files: { stats: state.stats }, dataFile: { cleanupOrphans: state.cleanup } } }));
vi.mock("@/lib/toast", () => ({ toast: { success: state.success, error: state.error } }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const preview = {
  success: true, dryRun: true, graceHours: 24,
  dbOrphansRemoved: 1, dbOrphanFilesRemoved: 0, dbOrphanBytes: 1024,
  contentOrphansRemoved: 2, contentOrphanFilesRemoved: 0, contentOrphanBytes: 2048,
  diskOrphansRemoved: 0, diskOrphanBytes: 0, diskScanSkipped: true,
  totalFreedBytes: 3072, totalRemovedItems: 3,
};
let root: Root;
let host: HTMLDivElement;
const onCleaned = vi.fn();
const onGo = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  state.stats.mockResolvedValue({ total: 12, totalBytes: 5 * 1024 * 1024, images: { count: 8, bytes: 0 }, files: { count: 4, bytes: 0 },
    unreferenced: { count: 0, bytes: 0 }, storage: { mode: "object", driver: "s3", source: "settings", bucket: "notes", prefix: "files" }, byMime: [] });
  state.getMe.mockResolvedValue({ role: "user" });
  state.cleanup.mockImplementation(async (options: { dryRun?: boolean }) => options.dryRun ? preview : { ...preview, dryRun: false });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function render() {
  await act(async () => root.render(<StorageToolsView refreshKey={0} isCurrent={() => true} onCleaned={onCleaned} onGo={onGo} />));
}
const confirmButton = () => [...host.querySelectorAll("button")].find((button) => button.textContent?.startsWith("fileExplorer.storage.confirm"));

it("shows usage, counts, storage location and the scan breakdown before any cleanup", async () => {
  await render();
  expect(host.textContent).toContain("5.0 MB");
  expect(host.textContent).toContain('fileExplorer.storage.countDetail|{"images":8,"files":4}');
  expect(host.textContent).toContain("files.storage.objectEnabled");
  expect(host.textContent).toContain("notes · /files");
  expect(host.textContent).toContain('fileExplorer.storage.categoryValue|{"count":2,"size":"2.0 KB"}');
  expect(host.textContent).toContain('fileExplorer.storage.categoryValue|{"count":1,"size":"1.0 KB"}');
  expect(host.textContent).toContain("fileExplorer.storage.diskSkipped");
  expect(host.textContent).toContain('fileExplorer.storage.total|{"count":3,"size":"3.0 KB"}');
  expect(host.textContent).toContain("fileExplorer.storage.scopeUser");
  expect(state.cleanup).toHaveBeenCalledTimes(1);
  expect(state.cleanup).toHaveBeenCalledWith({ dryRun: true });
  expect(confirmButton()!.textContent).toBe('fileExplorer.storage.confirm|{"count":3}');
});

it("cleans up only after the user confirms and a fresh scan still matches", async () => {
  await render();
  await act(async () => confirmButton()!.click());
  expect(state.cleanup.mock.calls.map(([options]) => options)).toEqual([{ dryRun: true }, { dryRun: true }, { dryRun: false }]);
  expect(onCleaned).toHaveBeenCalledTimes(1);
  expect(state.success).toHaveBeenCalledWith('fileExplorer.storage.done|{"count":3,"size":"3.0 KB"}');
});

it("does not delete anything when the result changed after the scan", async () => {
  await render();
  state.cleanup.mockImplementation(async (options: { dryRun?: boolean }) => options.dryRun
    ? { ...preview, contentOrphansRemoved: 3, contentOrphanBytes: 3072, totalRemovedItems: 4, totalFreedBytes: 4096 }
    : { ...preview, dryRun: false });
  await act(async () => confirmButton()!.click());
  expect(state.cleanup).not.toHaveBeenCalledWith({ dryRun: false });
  expect(onCleaned).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')!.textContent).toBe("fileExplorer.storage.changed");
  expect(confirmButton()!.textContent).toBe('fileExplorer.storage.confirm|{"count":4}');
});

it("offers no cleanup when nothing is reclaimable and explains the admin scope", async () => {
  state.getMe.mockResolvedValue({ role: "admin" });
  state.cleanup.mockResolvedValue({ ...preview, dbOrphansRemoved: 0, dbOrphanBytes: 0, contentOrphansRemoved: 0, contentOrphanBytes: 0,
    diskScanSkipped: false, totalRemovedItems: 0, totalFreedBytes: 0 });
  await render();
  expect(confirmButton()).toBeUndefined();
  expect(host.textContent).toContain("fileExplorer.storage.nothing");
  expect(host.textContent).toContain("fileExplorer.storage.scopeAdmin");
});

it("lists where every former tool feature lives and jumps there", async () => {
  await render();
  const rows = host.querySelectorAll('[aria-labelledby="file-storage-features"] li');
  expect(rows).toHaveLength(14);
  await act(async () => (rows[0].querySelector("button") as HTMLButtonElement).click());
  expect(onGo).toHaveBeenLastCalledWith("imageHost");
  await act(async () => (rows[10].querySelector("button") as HTMLButtonElement).click());
  expect(onGo).toHaveBeenLastCalledWith("files");
});

it("treats the reduced device-only response as nothing to clean", () => {
  const summary = summarizeCleanup({ totalRemovedItems: 0, totalFreedBytes: 0 });
  expect(summary).toMatchObject({ count: 0, bytes: 0, graceHours: 24, disk: { skipped: true } });
  expect(sameCleanupPreview(summary, summarizeCleanup({}))).toBe(true);
  expect(sameCleanupPreview(summary, summarizeCleanup({ totalRemovedItems: 1 }))).toBe(false);
});
