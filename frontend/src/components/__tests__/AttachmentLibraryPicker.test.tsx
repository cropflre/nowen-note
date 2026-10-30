// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { FileItem } from "@/types";
const mocks = vi.hoisted(() => ({ list: vi.fn(), prepare: vi.fn(), t: (key: string) => key }));
vi.mock("@/lib/api", () => ({ api: { files: { list: mocks.list, prepareInsert: mocks.prepare } } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
import Picker from "../AttachmentLibraryPicker";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const file = { id: "image", filename: "Design.png", mimeType: "image/png", category: "image", size: 4, url: "/api/attachments/image" } as FileItem;
let host: HTMLDivElement, root: Root;
const selected = vi.fn();
async function render(noteId = "note", workspaceId: string | null = "team") {
  await act(async () => root.render(<Picker open noteId={noteId} workspaceId={workspaceId} onClose={() => {}} onSelect={selected} />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}
beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  mocks.list.mockResolvedValue({ items: [file], page: 1, pageSize: 50, total: 51 });
  mocks.prepare.mockResolvedValue(file);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("uses target-note scope, paginates beyond fifty files and inserts only after authorization", async () => {
  await render();
  expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "team", page: 1 }));
  await act(async () => (document.querySelector('[role="option"]') as HTMLButtonElement).click());
  expect(mocks.prepare).toHaveBeenCalledWith("image", "note"); expect(selected).toHaveBeenCalledWith(file);
  await act(async () => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "assetOrganization.nextPage")!.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
});
it("keeps a failed selection retryable and does not insert a forbidden file", async () => {
  await render("note", null);
  expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "personal" }));
  mocks.prepare.mockRejectedValueOnce(new Error("Scope mismatch"));
  await act(async () => (document.querySelector('[role="option"]') as HTMLButtonElement).click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Scope mismatch"); expect(selected).not.toHaveBeenCalled();
  await act(async () => (document.querySelector('[role="option"]') as HTMLButtonElement).click());
  expect(selected).toHaveBeenCalledOnce();
});
it("discards a delayed authorization response after switching notes", async () => {
  let finish!: (value: FileItem) => void;
  mocks.prepare.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render();
  await act(async () => (document.querySelector('[role="option"]') as HTMLButtonElement).click());
  await render("another");
  await act(async () => finish(file));
  expect(selected).not.toHaveBeenCalled();
});
