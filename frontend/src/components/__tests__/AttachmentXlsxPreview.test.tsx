import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AttachmentXlsxPreview from "@/components/attachmentPreview/AttachmentXlsxPreview";
import { workbookFixture, dataWorksheet } from "@/lib/__tests__/xlsxFixture";
import { XLSX_PREVIEW_LIMITS } from "@/lib/sheetXlsx";
import zh from "@/i18n/locales/zh-CN.json";

const mocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), download: vi.fn(), success: vi.fn(), error: vi.fn(), workspace: "personal" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, args?: { name?: string }) => ((zh.xlsxPreview as Record<string, string>)[key.split(".").pop()!] || key).replace("{{name}}", args?.name || "") }) }));
vi.mock("@/lib/api", () => ({ getCurrentWorkspace: () => mocks.workspace }));
vi.mock("@/lib/knowledgeTreeApi", () => ({ knowledgeTreeApi: { create: mocks.create, list: mocks.list } }));
vi.mock("@/lib/downloadFile", () => ({ downloadAttachment: mocks.download }));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.success, error: mocks.error } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Excel attachment preview", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspace = "personal";
    mocks.list.mockResolvedValue({ nodes: [{ id: "folder", title: "数据", resourceType: "notebook", access: { capabilities: { canCreate: true } } }, { id: "forbidden", title: "只读目录", resourceType: "notebook", access: { capabilities: { canCreate: false } } }] });
    mocks.create.mockResolvedValue({ resourceId: "new-sheet" });
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  async function open(size = 123) {
    const buffer = await workbookFixture([{ name: "预算", xml: dataWorksheet }, { name: "说明", xml: '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>&lt;script&gt;alert(1)&lt;/script&gt;</t></is></c></row></sheetData></worksheet>' }]);
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers(), arrayBuffer: async () => buffer });
    await act(async () => root.render(<AttachmentXlsxPreview url="/attachment.xlsx" filename="预算.xlsx" size={size} />));
    for (let i = 0; i < 50 && host.textContent?.includes("正在加载"); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  function button(text: string) { return Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes(text))!; }
  it("shows original rows, switches sheets, escapes cell markup and downloads the untouched file", async () => {
    await open();
    expect(host.textContent).toContain("名称"); expect(host.textContent).toContain("3000");
    expect(host.querySelector("input")).toBeNull();
    expect(host.querySelector('[data-swipe-blocker="sheet-grid"]')?.classList.contains("overflow-auto")).toBe(true);
    expect(host.querySelector("thead")?.classList.contains("sticky")).toBe(true);
    await act(async () => button("说明").click());
    expect(host.textContent).toContain("<script>alert(1)</script>"); expect(host.querySelector("script")).toBeNull();
    await act(async () => button("下载原文件").click());
    expect(mocks.download).toHaveBeenCalledWith("/attachment.xlsx", "预算.xlsx");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("imports only after destination selection and creates an independent sheet with header semantics", async () => {
    await open();
    await act(async () => button("导入为轻量表格").click());
    expect(mocks.create).not.toHaveBeenCalled();
    expect(host.querySelectorAll("option")).toHaveLength(2);
    await act(async () => { const select = host.querySelector("select")!; select.value = "folder"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => button("导入工作表").click());
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ parentId: "folder", nodeType: "sheet", title: "预算 · 预算", sheetData: expect.objectContaining({ cells: { "r1:c1": "房租", "r1:c2": "3000" } }) }));
    expect(mocks.success).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects oversize files before fetching and keeps a download fallback", async () => {
    await open(XLSX_PREVIEW_LIMITS.fileBytes + 1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("超出预览限制");
    await act(async () => button("下载原文件").click()); expect(mocks.download).toHaveBeenCalledOnce();
  });
  it("reports broken and encrypted workbooks with a download fallback", async () => {
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers(), arrayBuffer: async () => new Uint8Array([0xd0, 0xcf]).buffer });
    await act(async () => root.render(<AttachmentXlsxPreview url="/broken.xlsx" filename="broken.xlsx" size={2} />));
    for (let i = 0; i < 20 && !host.querySelector('[role="alert"]'); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(host.textContent).toContain("损坏、加密"); expect(button("下载原文件")).toBeDefined();
  });
  it("prevents import into a workspace that changed while the destination chooser was open", async () => {
    await open(); await act(async () => button("导入为轻量表格").click());
    mocks.workspace = "other";
    await act(async () => button("导入工作表").click());
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("工作区已切换"));
  });
});
