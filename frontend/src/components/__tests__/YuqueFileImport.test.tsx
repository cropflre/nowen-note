import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YuqueFileImport from "../YuqueFileImport";

const mocks = vi.hoisted(() => ({ read: vi.fn(), run: vi.fn(), view: vi.fn(), imported: vi.fn(), busy: vi.fn() }));
vi.mock("@/lib/yuqueFileImport", () => ({ readYuqueExport: mocks.read, importYuqueFiles: mocks.run }));
vi.mock("@/lib/api", () => ({ api: { getNotebooks: async () => [] } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, options?: { count?: number; created?: number; skipped?: number }) =>
  `${key}${options?.count === undefined ? "" : ` ${options.count}`}${options?.created === undefined ? "" : ` ${options.created}/${options.skipped}`}`,
}) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const docs = [
  { key: "a", title: "A", book: "Book", path: ["Book"], content: "A", warnings: [] },
  { key: "b", title: "B", book: "Book", path: ["Book"], content: "B", warnings: [] },
];
let root: Root;
const props = { userId: "user", workspaceId: "personal", workspaceName: "Personal", disabled: false,
  onBusyChange: mocks.busy, onImported: mocks.imported, onView: mocks.view };
function button(key: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.startsWith(`yuqueFileImport.${key}`))!; }
async function choose() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["body"], "book.md")] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
}
beforeEach(async () => {
  vi.clearAllMocks(); mocks.read.mockResolvedValue(docs); mocks.view.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ created: 2, skipped: 0, failed: [], firstNoteId: "note-a", notebookId: "folder" });
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<YuqueFileImport {...props}/>));
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; });

describe("Yuque file import workflow", () => {
  it("defaults to the whole book and prevents importing an empty selection", async () => {
    await choose();
    expect(button("start").textContent).toContain("2");
    expect(button("start").disabled).toBe(false);
    act(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(button("start").disabled).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("retains the result and retries only unfinished items before viewing the notes", async () => {
    await choose();
    mocks.run.mockResolvedValueOnce({ created: 1, skipped: 0, failed: [{ key: "b", title: "B", message: "temporary failure" }], firstNoteId: "note-a", notebookId: "folder" });
    await act(async () => button("start").click());
    expect(document.body.textContent).toContain("temporary failure");
    expect(button("retry")).toBeTruthy();
    mocks.run.mockResolvedValueOnce({ created: 1, skipped: 0, failed: [], firstNoteId: "note-b", notebookId: "folder" });
    await act(async () => button("retry").click());
    expect(mocks.run.mock.calls[1][0]).toEqual([docs[1]]);
    expect(document.body.textContent).toContain("yuqueFileImport.result 2/0");
    expect(button("retry")).toBeUndefined();
    await act(async () => button("view").click());
    expect(mocks.view.mock.calls[0][0].firstNoteId).toBe("note-a");
    expect(mocks.busy.mock.calls.map((call) => call[0])).toEqual([true, false, true, false, true, false]);
  });
  it("stops actions when the target is unavailable and shows a readable file error", async () => {
    mocks.read.mockRejectedValueOnce(new Error("YUQUE_NO_MARKDOWN"));
    await choose();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("YUQUE_NO_MARKDOWN");
    expect(button("start")).toBeUndefined();
    await act(async () => root.render(<YuqueFileImport {...props} disabled/>));
    expect(button("choose").disabled).toBe(true);
    await choose();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
});
