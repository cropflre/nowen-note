// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workbookFixture, dataWorksheet } from "@/lib/__tests__/xlsxFixture";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@/lib/knowledgeTreeApi", () => ({
  knowledgeTreeApi: {
    create: mocks.create,
  },
}));

import {
  importSheetFileAsNode,
  parseSheetImportFile,
  pickSheetFile,
} from "@/lib/sheetNoteService";

describe("sheetNoteService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({
      id: "sheet:s1",
      resourceId: "s1",
      resourceType: "sheet",
      nodeType: "sheet",
      title: "季度预算",
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("imports an .xlsx file into a sheet node under the target parent", async () => {
    const buffer = await workbookFixture([{ name: "预算", xml: dataWorksheet }]);
    const file = new File([buffer], "季度预算.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => buffer,
    });

    const node = await importSheetFileAsNode({ parentId: "notebook:n1", file });

    expect(node.resourceId).toBe("s1");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      parentId: "notebook:n1",
      nodeType: "sheet",
      title: "季度预算",
      sheetData: expect.objectContaining({
        version: 1,
        cells: expect.objectContaining({ "r1:c1": "房租", "r1:c2": "3000" }),
      }),
    }));
  });

  it("imports a .csv file into a sheet node at root when parentId is null", async () => {
    const csv = "项目,负责人\n需求评审,张三\n上线检查,李四";
    const file = new File([csv], "发布清单.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", {
      value: async () => csv,
    });

    await importSheetFileAsNode({ parentId: null, file });

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      parentId: null,
      nodeType: "sheet",
      title: "发布清单",
      sheetData: expect.objectContaining({
        columns: expect.arrayContaining([
          expect.objectContaining({ title: "项目" }),
          expect.objectContaining({ title: "负责人" }),
        ]),
      }),
    }));
  });

  it("rejects unsupported legacy .xls files", async () => {
    const file = new File(["legacy"], "old.xls", { type: "application/vnd.ms-excel" });
    await expect(parseSheetImportFile(file)).rejects.toThrow("暂只支持导入 .xlsx 或 .csv 表格文件");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("opens a file picker accepting .xlsx and .csv", async () => {
    let picker: HTMLInputElement | null = null;
    const nativeCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      const element = nativeCreateElement(tagName);
      if (tagName === "input") picker = element as HTMLInputElement;
      return element;
    }) as typeof document.createElement);
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function click(this: HTMLInputElement) {
      Object.defineProperty(this, "files", {
        configurable: true,
        value: [new File(["a,b\n1,2"], "data.csv", { type: "text/csv" })],
      });
      this.dispatchEvent(new Event("change"));
    });

    const picked = await pickSheetFile();
    const pickerElement = picker as unknown as HTMLInputElement;
    expect(pickerElement.accept).toContain(".xlsx");
    expect(pickerElement.accept).toContain(".csv");
    expect(picked?.name).toBe("data.csv");
  });
});
