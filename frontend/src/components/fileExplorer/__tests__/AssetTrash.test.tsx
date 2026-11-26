// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), restore: vi.fn(), purge: vi.fn(), empty: vi.fn(), confirm: vi.fn(), toastInfo: vi.fn(), toastError: vi.fn(), toastSuccess: vi.fn(), t: (key: string, params?: Record<string, unknown>) => params?.count !== undefined ? `${key}:${params.count}` : key }));
vi.mock("@/lib/api", () => ({ api: { files: { trash: { list: mocks.list, restore: mocks.restore, purge: mocks.purge, empty: mocks.empty } } } }));
vi.mock("@/components/ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("@/lib/toast", () => ({ toast: { info: mocks.toastInfo, error: mocks.toastError, success: mocks.toastSuccess } }));
vi.mock("react-i18next", () => ({ initReactI18next: { type: "3rdParty", init() {} }, useTranslation: () => ({ t: mocks.t }) }));
import AssetTrash from "../AssetTrash";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const isCurrent = () => true;
beforeEach(async () => {
  vi.clearAllMocks(); mocks.list.mockResolvedValue({ supported: true, total: 1, entries: [{ id: "file", filename: "Retained.txt", size: 4, trashedAt: "2026-10-15 00:00:00" }] });
  mocks.restore.mockResolvedValue({ restored: [{ id: "file", fallback: false }] });
  mocks.purge.mockResolvedValue({ cleanupPending: [] });
  mocks.empty.mockResolvedValue({ success: true, count: 1, skipped: 0, cleanupPending: [] });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<AssetTrash onBack={() => {}} isCurrent={isCurrent} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function select() { await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="Retained.txt"]')!.click()); }
function button(key: string) { return Array.from(host.querySelectorAll("button")).find((item) => item.textContent === key)!; }
it("restores selected IDs and retains retryable errors without hiding the file", async () => {
  await select(); mocks.restore.mockRejectedValueOnce(new Error("Not authorized"));
  await act(async () => button("assetTrash.restore").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Not authorized"); expect(host.textContent).toContain("Retained.txt");
  await act(async () => button("assetTrash.restore").click()); expect(mocks.restore).toHaveBeenLastCalledWith(["file"]);
});
it("requires explicit confirmation before permanent deletion", async () => {
  await select(); mocks.confirm.mockResolvedValueOnce(false);
  await act(async () => button("assetTrash.purge").click()); expect(mocks.purge).not.toHaveBeenCalled();
  mocks.confirm.mockResolvedValueOnce(true);
  await act(async () => button("assetTrash.purge").click()); expect(mocks.purge).toHaveBeenCalledWith(["file"]);
});
it("supports select-all page, cross-page select all with 200-item chunking, and empty trash", async () => {
  const manyEntries = Array.from({ length: 210 }, (_, index) => ({
    id: `trashed-${index}`, filename: `File-${index}.png`, mimeType: "image/png", size: 10, trashedAt: "2026-10-15 00:00:00", originalFolderId: null,
  }));
  mocks.list.mockImplementation(async (page = 1, pageSize = 50) => ({
    supported: true,
    total: manyEntries.length,
    entries: manyEntries.slice((page - 1) * pageSize, page * pageSize),
  }));
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<AssetTrash onBack={() => {}} isCurrent={isCurrent} />));

  const selectPageBox = () => host.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label^="assetTrash."]')!;
  await act(async () => selectPageBox().click());
  expect(host.textContent).toContain("fileExplorer.selected:50");
  expect(selectPageBox().getAttribute("aria-label")).toBe("assetTrash.deselectAll");

  // Select all 210 items across pages and purge -> chunked into 200 + 10.
  await act(async () => button("assetTrash.selectAllCount:210").click());
  expect(host.textContent).toContain("fileExplorer.selected:210");
  mocks.confirm.mockResolvedValueOnce(true);
  await act(async () => button("assetTrash.purge").click());
  expect(mocks.purge).toHaveBeenCalledTimes(2);
  expect(mocks.purge.mock.calls[0][0]).toHaveLength(200);
  expect(mocks.purge.mock.calls[1][0]).toHaveLength(10);

  // Empty trash asks for confirmation first, then empties and reports skipped items if any.
  mocks.confirm.mockResolvedValueOnce(false);
  await act(async () => button("assetTrash.emptyAction").click());
  expect(mocks.empty).not.toHaveBeenCalled();

  mocks.confirm.mockResolvedValueOnce(true);
  mocks.empty.mockResolvedValueOnce({ success: true, count: 205, skipped: 5, cleanupPending: [] });
  mocks.list.mockResolvedValue({ supported: true, total: 5, entries: manyEntries.slice(0, 5) });
  await act(async () => button("assetTrash.emptyAction").click());
  expect(mocks.empty).toHaveBeenCalledTimes(1);
  expect(mocks.toastInfo).toHaveBeenCalledWith("assetTrash.emptyPartial:205");
});
