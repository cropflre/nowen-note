/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { applySidebarSearchExperience } from "@/lib/sidebarSearchExperience";

describe("applySidebarSearchExperience", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("retires the duplicated global search row and clears an active legacy query", () => {
    document.body.innerHTML = `
      <div id="legacy-row">
        <div>
          <svg aria-hidden="true"></svg>
          <input data-sidebar-search value="React" />
        </div>
      </div>
    `;

    const input = document.querySelector<HTMLInputElement>("[data-sidebar-search]")!;
    const inputEvent = vi.fn();
    input.addEventListener("input", inputEvent);

    expect(applySidebarSearchExperience(document)).toBe(true);

    const row = document.querySelector<HTMLElement>("#legacy-row")!;
    expect(row.dataset.retiredSidebarSearchRow).toBe("true");
    expect(row.getAttribute("aria-hidden")).toBe("true");
    expect(input.value).toBe("");
    expect(input.tabIndex).toBe(-1);
    expect(inputEvent).toHaveBeenCalledTimes(1);
  });

  it("makes the knowledge tree field clearly local to folders and documents", () => {
    document.body.innerHTML = `
      <div id="tree-filter">
        <svg aria-hidden="true"></svg>
        <input data-knowledge-tree-search placeholder="筛选内容树…" />
      </div>
    `;

    applySidebarSearchExperience(document);

    const surface = document.querySelector<HTMLElement>("#tree-filter")!;
    const input = document.querySelector<HTMLInputElement>("[data-knowledge-tree-search]")!;

    expect(surface.dataset.treeFilterSurface).toBe("true");
    expect(input.placeholder).toBe("筛选目录与文档…");
    expect(input.getAttribute("aria-label")).toBe("筛选当前目录中的文件夹与文档");
    expect(input.title).toBe("仅筛选当前内容树，不搜索笔记正文");
    expect(input.dataset.searchScope).toBe("tree");
  });

  it("does not dispatch duplicate clear events when applied repeatedly", () => {
    document.body.innerHTML = `
      <div><div><input data-sidebar-search value="query" /></div></div>
    `;

    const input = document.querySelector<HTMLInputElement>("[data-sidebar-search]")!;
    const inputEvent = vi.fn();
    input.addEventListener("input", inputEvent);

    applySidebarSearchExperience(document);
    applySidebarSearchExperience(document);

    expect(inputEvent).toHaveBeenCalledTimes(1);
  });
});
