import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const sidebarSource = fs.readFileSync(
  path.resolve(__dirname, "..", "Sidebar.tsx"),
  "utf8",
);

describe("sidebar notebook sort controls", () => {
  it("keeps only the top-level sort control", () => {
    expect(sidebarSource).toContain("data-nowen-notebook-sort");
    expect(sidebarSource).not.toContain("onSortMenuToggle");
    expect(sidebarSource).not.toContain("getNotebookSortPrefForParent");
  });
});
