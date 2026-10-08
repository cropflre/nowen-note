import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SheetGrid from "@/components/SheetGrid";
import { normalizeSheetData } from "@/lib/sheetModel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("shared SheetGrid", () => {
  let host: HTMLDivElement; let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const data = normalizeSheetData({ rows: Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, height: 32 })), columns: [{ id: "c1", title: "日期", type: "date", width: 120 }], cells: { "r0:c1": "2026-10-03", "r970:c1": "最后几行" } });
  it("renders date data as selectable read-only text and windows rows after scrolling", () => {
    act(() => root.render(<SheetGrid data={data} />));
    expect(host.textContent).toContain("2026-10-03"); expect(host.querySelector("input")).toBeNull();
    expect(host.querySelectorAll("tbody tr").length).toBeLessThan(90);
    act(() => { const grid = host.querySelector<HTMLDivElement>('[data-swipe-blocker]')!; grid.scrollTop = 31000; grid.dispatchEvent(new Event("scroll", { bubbles: true })); });
    expect(host.textContent).toContain("最后几行"); expect(host.querySelectorAll("tbody tr").length).toBeLessThan(90);
  });
  it("keeps editor selection and cell edit recipes functional", () => {
    const onChange = vi.fn(); const onSelect = vi.fn();
    const small = { ...data, rows: data.rows.slice(0, 1) };
    act(() => root.render(<SheetGrid data={small} canEdit onChange={onChange} onSelect={onSelect} />));
    const input = host.querySelector<HTMLInputElement>("input")!;
    act(() => input.focus()); expect(onSelect).toHaveBeenCalledWith({ rowId: "r0", columnId: "c1" });
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2026-10-04"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(onChange).toHaveBeenCalledOnce(); expect(onChange.mock.calls[0][0](small).cells["r0:c1"]).toBe("2026-10-04");
    expect(host.querySelectorAll('[draggable="true"]')).toHaveLength(2);
  });
});
