import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import EncryptedNoteConversionPreflight from "@/components/EncryptedNoteConversionPreflight";
import { api } from "@/lib/api";
import { inspectBrowserConversionCopies, type EncryptionConversionPreflight } from "../conversionPreflight";

vi.mock("@/lib/api", () => ({ api: { getEncryptionConversionPreflight: vi.fn(), getMe: vi.fn() } }));
vi.mock("../conversionPreflight", () => ({ inspectBrowserConversionCopies: vi.fn() }));
const report = (noteId = "note"): EncryptionConversionPreflight => ({
  noteId, version: 7, contentFormat: "markdown", canConvert: false,
  blockers: ["conversion_not_enabled", "templates", "audit_incomplete"],
  copies: [{ kind: "templates", records: 2, complete: true }, { kind: "history", records: 4, complete: false }],
  unreviewed: [{ table: "private_internal_table", records: 1 }], previewPresent: true, activeCollaborators: 0,
  physicalErasure: "not_verified", externalCopies: "not_inspectable",
});
let root: Root; let container: HTMLDivElement;
const close = vi.fn();
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(api.getMe).mockResolvedValue({ id: "owner" } as unknown as import("@/types/index").User);
  vi.mocked(api.getEncryptionConversionPreflight).mockResolvedValue(report());
  vi.mocked(inspectBrowserConversionCopies).mockResolvedValue({ draft: true, queue: 1, cache: null, collaboration: null });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = (noteId = "note") => act(async () => { root.render(<EncryptedNoteConversionPreflight noteId={noteId} onClose={close} />); });
const buttons = () => [...container.querySelectorAll("button")];

it("shows counts, uncertainty and limits; conversion remains disabled even with a forged ready report", async () => {
  vi.mocked(api.getEncryptionConversionPreflight).mockResolvedValue({ ...report(), canConvert: true } as unknown as EncryptionConversionPreflight);
  await render();
  expect(container.textContent).toContain("笔记模板"); expect(container.textContent).toContain("检查不完整");
  expect(container.textContent).toContain("未能确认"); expect(container.textContent).toContain("旧备份");
  expect(container.textContent).not.toContain("private_internal_table");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(buttons().find((button) => button.textContent === "转换尚未开放")?.disabled).toBe(true);
  expect(inspectBrowserConversionCopies).toHaveBeenCalledWith("note", "owner");
  await act(async () => buttons().find((button) => button.textContent === "重新检查")!.click());
  expect(api.getEncryptionConversionPreflight).toHaveBeenCalledTimes(2);
});
it("failed inspection exposes no response text and no cached previous success", async () => {
  await render();
  vi.mocked(api.getEncryptionConversionPreflight).mockRejectedValue(new Error("private-source"));
  await act(async () => buttons().find((button) => button.textContent === "重新检查")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("检查失败");
  expect(container.textContent).not.toContain("private-source"); expect(container.textContent).not.toContain("服务器版本：7");
});
it("a late response from a previously selected note is discarded", async () => {
  let resolve!: (value: EncryptionConversionPreflight) => void;
  vi.mocked(api.getEncryptionConversionPreflight).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render();
  vi.mocked(api.getEncryptionConversionPreflight).mockResolvedValue({ ...report("next"), version: 9 });
  await render("next");
  await act(async () => resolve(report()));
  expect(container.textContent).toContain("服务器版本：9"); expect(container.textContent).not.toContain("服务器版本：7");
});
it.each(["nowen:token-changed", "nowen:server-url-changed"])("%s closes the dialog and discards pending responses", async (event) => {
  let resolve!: (value: EncryptionConversionPreflight) => void;
  vi.mocked(api.getEncryptionConversionPreflight).mockImplementation(() => new Promise((done) => { resolve = done; }));
  await render();
  act(() => window.dispatchEvent(new Event(event))); expect(close).toHaveBeenCalledTimes(1);
  await act(async () => resolve(report()));
  expect(inspectBrowserConversionCopies).not.toHaveBeenCalled(); expect(container.textContent).not.toContain("服务器版本");
});
it("Escape closes and focus stays inside the dialog", async () => {
  await render(); const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(document.activeElement).toBe(dialog);
  const enabled = buttons().filter((button) => !button.disabled); enabled[enabled.length - 1].focus();
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(enabled[0]);
  act(() => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(close).toHaveBeenCalledTimes(1);
});
it("cross-window auth changes close the dialog while unrelated settings keep it open", async () => {
  await render();
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: "i18nextLng" })));
  expect(close).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: "nowen-token" })));
  expect(close).toHaveBeenCalledTimes(1); expect(container.textContent).not.toContain("服务器版本");
});
