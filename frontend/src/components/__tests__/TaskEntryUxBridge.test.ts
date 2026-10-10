// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  TASK_ENTRY_HIERARCHY_CSS,
  annotateTaskEntrySurfaces,
} from "@/components/tasks/TaskEntryUxBridge";

describe("TaskEntryUxBridge", () => {
  beforeEach(() => {
    document.documentElement.lang = "zh-CN";
    document.body.innerHTML = "";
  });

  it("separates search and create surfaces without changing TaskCenter state", () => {
    document.body.innerHTML = `
      <main>
        <div id="search" class="border-b">
          <svg class="lucide lucide-search"></svg>
          <input type="text" />
        </div>
        <div id="create-section" class="border-b">
          <div data-task-quick-add></div>
        </div>
      </main>
    `;

    annotateTaskEntrySurfaces(document);

    expect(document.querySelector("#search")?.hasAttribute("data-task-search-section")).toBe(true);
    expect(document.querySelector("#create-section")?.hasAttribute("data-task-create-section")).toBe(true);
    expect(document.querySelector<HTMLInputElement>("#search input")?.getAttribute("aria-label")).toBe("搜索任务");
  });

  it("keeps search secondary and quick add visually primary", () => {
    expect(TASK_ENTRY_HIERARCHY_CSS).toContain("width: min(360px, calc(100% - 40px))");
    expect(TASK_ENTRY_HIERARCHY_CSS).toContain("align-self: flex-end");
    expect(TASK_ENTRY_HIERARCHY_CSS).toContain("[data-task-create-section]");
    expect(TASK_ENTRY_HIERARCHY_CSS).toContain("border-bottom: 0 !important");
  });
});
