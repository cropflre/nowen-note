import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAttachmentWorkbook } from "@/lib/attachmentXlsx";
import { XLSX_PREVIEW_LIMITS } from "@/lib/sheetXlsx";
import { workbookFixture, dataWorksheet } from "./xlsxFixture";

afterEach(() => { vi.unstubAllGlobals(); });

describe("bounded XLSX attachment fetch", () => {
  it("rejects declared oversized HTTP responses and cancels their body", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: new Headers({ "Content-Length": String(XLSX_PREVIEW_LIMITS.fileBytes + 1) }), body: { cancel } }));
    await expect(loadAttachmentWorkbook("/file.xlsx", 0, new AbortController().signal)).rejects.toMatchObject({ code: "limit" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("stops chunked downloads exceeding actual size even without Content-Length", async () => {
    const cancel = vi.fn();
    const read = vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(11 * 1024 * 1024) });
    const releaseLock = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), body: { getReader: () => ({ read, cancel, releaseLock }) } }));
    await expect(loadAttachmentWorkbook("/file.xlsx", 0, new AbortController().signal)).rejects.toMatchObject({ code: "limit" });
    expect(read).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
  });
  it("combines streaming chunks and parses their workbook", async () => {
    const bytes = new Uint8Array(await workbookFixture([{ name: "表", xml: dataWorksheet }]));
    const read = vi.fn().mockResolvedValueOnce({ done: false, value: bytes.slice(0, 50) }).mockResolvedValueOnce({ done: false, value: bytes.slice(50) }).mockResolvedValueOnce({ done: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, headers: new Headers(), body: { getReader: () => ({ read, releaseLock: vi.fn() }) } }));
    expect((await loadAttachmentWorkbook("/file.xlsx", 0, new AbortController().signal)).sheets[0].data.cells["r2:c2"]).toBe("3000");
  });
  it("passes cancellation through to fetch", async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")); vi.stubGlobal("fetch", fetch);
    await expect(loadAttachmentWorkbook("/file.xlsx", 0, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledWith("/file.xlsx", { signal: controller.signal });
  });
});
