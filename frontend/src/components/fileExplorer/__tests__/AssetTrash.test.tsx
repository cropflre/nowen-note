// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), restore: vi.fn(), purge: vi.fn(), confirm: vi.fn(), t: (key: string) => key }));
vi.mock("@/lib/api", () => ({ api: { files: { trash: { list: mocks.list, restore: mocks.restore, purge: mocks.purge } } } }));
vi.mock("@/components/ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("@/lib/toast", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({ initReactI18next: { type: "3rdParty", init() {} }, useTranslation: () => ({ t: mocks.t }) }));
import AssetTrash from "../AssetTrash";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const isCurrent = () => true;
beforeEach(async () => {
  vi.clearAllMocks(); mocks.list.mockResolvedValue({ supported: true, total: 1, entries: [{ id: "file", filename: "Retained.txt", size: 4, trashedAt: "2026-10-15 00:00:00" }] });
  mocks.restore.mockResolvedValue({ restored: [{ id: "file", fallback: false }] }); mocks.purge.mockResolvedValue({ cleanupPending: [] });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<AssetTrash onBack={() => {}} isCurrent={isCurrent} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function select() { await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); }
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
