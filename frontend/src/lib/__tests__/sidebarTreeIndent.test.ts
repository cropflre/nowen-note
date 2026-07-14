import { describe, expect, it } from "vitest";
import * as sidebarLayout from "@/lib/sidebarLayout";

describe("sidebar tree indentation", () => {
  it("uses compact 10px spacing for each notebook level", () => {
    expect(sidebarLayout.SIDEBAR_TREE_INDENT).toBe(10);
  });

  it("keeps the first child notebook close to its parent", () => {
    const paddingLeft = (sidebarLayout as typeof sidebarLayout & {
      sidebarNotebookPaddingLeft?: (depth: number, compact?: boolean) => number;
    }).sidebarNotebookPaddingLeft;

    expect(paddingLeft).toBeTypeOf("function");
    expect(paddingLeft?.(0)).toBe(8);
    expect(paddingLeft?.(1)).toBe(22);
    expect(paddingLeft?.(2)).toBe(32);
  });

  it("keeps deeply nested notebook levels compact inside the mobile drawer", () => {
    const paddingLeft = (sidebarLayout as typeof sidebarLayout & {
      sidebarNotebookPaddingLeft?: (depth: number, compact?: boolean) => number;
    }).sidebarNotebookPaddingLeft;

    expect(paddingLeft?.(0, true)).toBe(4);
    expect(paddingLeft?.(1, true)).toBe(8);
    expect(paddingLeft?.(2, true)).toBe(12);
    expect(paddingLeft?.(3, true)).toBe(16);
  });

  it("reduces vertical notebook row padding inside the mobile drawer", () => {
    const paddingY = (sidebarLayout as typeof sidebarLayout & {
      sidebarNotebookRowPaddingY?: (compact?: boolean) => number;
    }).sidebarNotebookRowPaddingY;

    expect(paddingY).toBeTypeOf("function");
    expect(paddingY?.(false)).toBe(6);
    expect(paddingY?.(true)).toBe(2);
  });

  it("does not reserve an invisible drag handle slot on touch layouts", () => {
    const showsDragHandle = (sidebarLayout as typeof sidebarLayout & {
      sidebarNotebookShowsDragHandle?: (compact?: boolean) => boolean;
    }).sidebarNotebookShowsDragHandle;

    expect(showsDragHandle).toBeTypeOf("function");
    expect(showsDragHandle?.(false)).toBe(true);
    expect(showsDragHandle?.(true)).toBe(false);
  });

  it("keeps the disclosure arrow close to the notebook icon on mobile", () => {
    const disclosureChrome = (sidebarLayout as typeof sidebarLayout & {
      sidebarNotebookDisclosureChrome?: (compact?: boolean) => { size: number; gap: number };
    }).sidebarNotebookDisclosureChrome;

    expect(disclosureChrome).toBeTypeOf("function");
    expect(disclosureChrome?.(false)).toEqual({ size: 18, gap: 4 });
    expect(disclosureChrome?.(true)).toEqual({ size: 14, gap: 0 });
  });
});
