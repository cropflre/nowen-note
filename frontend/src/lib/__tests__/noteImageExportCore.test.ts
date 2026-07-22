// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { chooseRasterPlan, computePageSlices } from "@/lib/noteImageExportCore";
import { noteContentToExportHtml } from "@/lib/exportService";
import {
  findOverflowingExportTables,
  normalizeExportTable,
  normalizeExportTables,
} from "@/lib/noteImageExportTables";

describe("note image export canvas planning", () => {
  it("keeps ordinary notes as a single high-resolution long image", () => {
    const plan = chooseRasterPlan({
      width: 794,
      height: 3200,
      requestedScale: 2,
      layout: "auto",
      blockBottoms: [],
    });

    expect(plan.mode).toBe("long");
    expect(plan.slices).toEqual([{ offset: 0, height: 3200 }]);
    expect(plan.scale).toBeGreaterThanOrEqual(1);
  });

  it("automatically paginates content that would exceed safe canvas limits", () => {
    const plan = chooseRasterPlan({
      width: 794,
      height: 24000,
      requestedScale: 2,
      layout: "auto",
      blockBottoms: [1200, 2700, 4100, 5600, 7100, 8600, 10100, 11600, 13100, 14600, 16100, 17600, 19100, 20600, 22100, 23800],
    });

    expect(plan.mode).toBe("pages");
    expect(plan.slices.length).toBeGreaterThan(10);
    expect(plan.warning).toContain("Canvas");
    expect(plan.slices.reduce((sum, slice) => sum + slice.height, 0)).toBe(24000);
  });

  it("uses nearby block bottoms instead of cutting every page at a fixed pixel", () => {
    const slices = computePageSlices(3600, 1400, [900, 1320, 2100, 2700, 3540]);

    expect(slices[0]).toEqual({ offset: 0, height: 1320 });
    expect(slices[1]).toEqual({ offset: 1320, height: 1380 });
    expect(slices.reduce((sum, slice) => sum + slice.height, 0)).toBe(3600);
  });

  it("honors explicit pagination even for short safe canvases", () => {
    const plan = chooseRasterPlan({
      width: 794,
      height: 2800,
      requestedScale: 2,
      layout: "pages",
      blockBottoms: [1200, 2500],
    });

    expect(plan.mode).toBe("pages");
    expect(plan.slices.length).toBeGreaterThan(1);
    expect(plan.warning).toBeUndefined();
  });
});


describe("note image export table normalization", () => {
  it("preserves all cells while scaling editor pixel widths into the export body", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <table style="width:1200px;min-width:1200px">
        <colgroup>
          <col style="width:800px;min-width:800px">
          <col style="width:200px;min-width:200px">
          <col style="width:200px;min-width:200px">
        </colgroup>
        <tbody>
          <tr><th>发票内容</th><th>购买平台</th><th>是否开票</th></tr>
          <tr><td style="width:800px;min-width:800px">广告机来回运费</td><td>货拉拉</td><td>未开发票</td></tr>
        </tbody>
      </table>`;

    expect(normalizeExportTables(root, 682)).toBe(1);
    const table = root.querySelector("table")!;
    const cols = Array.from(table.querySelectorAll("col"));
    expect(cols).toHaveLength(3);
    expect(Number.parseFloat(cols[0].style.width)).toBeCloseTo(66.6667, 3);
    expect(Number.parseFloat(cols[1].style.width)).toBeCloseTo(16.6667, 3);
    expect(Number.parseFloat(cols[2].style.width)).toBeCloseTo(16.6666, 3);
    expect(table.textContent).toContain("购买平台");
    expect(table.textContent).toContain("是否开票");
    expect(table.style.getPropertyValue("table-layout")).toBe("fixed");
    expect(table.style.getPropertyPriority("width")).toBe("important");
    expect(table.querySelector("td")?.getAttribute("style")).not.toContain("800px");
  });

  it("uses colwidth hints, keeps merged-cell semantics and retains row height", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <table>
        <tbody>
          <tr style="height:72px">
            <th colspan="2" colwidth="420,180">合并表头</th>
            <th rowspan="2" data-colwidth="200">状态</th>
          </tr>
          <tr><td colwidth="420">内容</td><td colwidth="180">平台</td></tr>
        </tbody>
      </table>`;
    const table = root.querySelector("table")!;
    const percentages = normalizeExportTable(table);

    expect(percentages).toHaveLength(3);
    expect(percentages[0]).toBeGreaterThan(percentages[1]);
    expect(table.querySelector("th")?.getAttribute("colspan")).toBe("2");
    expect(table.querySelector("th[rowspan]")?.getAttribute("rowspan")).toBe("2");
    expect(table.querySelector("tr")?.style.height).toBe("72px");
    expect(table.querySelector("[colwidth]")).toBeNull();
    expect(table.querySelector("[data-colwidth]")).toBeNull();
  });

  it("keeps every column in a wide twelve-column table", () => {
    const root = document.createElement("div");
    const cells = Array.from({ length: 12 }, (_, index) => `<td width="${index === 0 ? 600 : 100}px">列${index + 1}</td>`).join("");
    root.innerHTML = `<table><tbody><tr>${cells}</tr></tbody></table>`;
    normalizeExportTables(root, 682);

    const table = root.querySelector("table")!;
    expect(table.querySelectorAll("col")).toHaveLength(12);
    expect(table.querySelectorAll("td")).toHaveLength(12);
    expect(table.textContent).toContain("列12");
    const sum = Array.from(table.querySelectorAll("col"))
      .reduce((total, col) => total + Number.parseFloat((col as HTMLElement).style.width), 0);
    expect(sum).toBeCloseTo(100, 3);
  });

  it("detects a table that still exceeds its rendered parent", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div><table><tbody><tr><td>内容</td></tr></tbody></table></div>`;
    const parent = root.firstElementChild as HTMLElement;
    const table = root.querySelector("table")!;
    Object.defineProperty(parent, "clientWidth", { configurable: true, value: 682 });
    Object.defineProperty(table, "scrollWidth", { configurable: true, value: 700 });
    table.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0, right: 682, bottom: 100,
      width: 682, height: 100, toJSON: () => ({}),
    });
    expect(findOverflowingExportTables(root, 682)).toEqual([table]);
  });

  it("does not lose second and third columns during Tiptap JSON to HTML conversion", () => {
    const text = (value: string) => ({ type: "paragraph", content: [{ type: "text", text: value }] });
    const cell = (type: "tableHeader" | "tableCell", value: string, width: number) => ({
      type,
      attrs: { colspan: 1, rowspan: 1, colwidth: [width] },
      content: [text(value)],
    });
    const content = JSON.stringify({
      type: "doc",
      content: [{
        type: "table",
        content: [
          { type: "tableRow", content: [
            cell("tableHeader", "发票内容", 700),
            cell("tableHeader", "购买平台", 200),
            cell("tableHeader", "是否开票", 200),
          ] },
          { type: "tableRow", content: [
            cell("tableCell", "广告机来回运费", 700),
            cell("tableCell", "货拉拉", 200),
            cell("tableCell", "未开发票", 200),
          ] },
        ],
      }],
    });

    const html = noteContentToExportHtml(content, "", "tiptap-json");
    expect(html).toContain("发票内容");
    expect(html).toContain("购买平台");
    expect(html).toContain("是否开票");
    expect((html.match(/<th/g) || [])).toHaveLength(3);
    expect((html.match(/<td/g) || [])).toHaveLength(3);
  });
});
