import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve(__dirname, "../tasks/TaskMetadataWorkspace.tsx"),
  "utf8",
);

describe("TaskMetadataWorkspace workspace switch", () => {
  it("clears workspace-scoped state before loading the next workspace", () => {
    const handlerStart = source.indexOf("const onWorkspaceChanged = () => {");
    const loadStart = source.indexOf("void loadMetadata();", handlerStart);
    const handler = source.slice(handlerStart, loadStart);

    expect(handlerStart).toBeGreaterThan(-1);
    expect(loadStart).toBeGreaterThan(handlerStart);
    expect(handler).toContain("setSnapshot(emptySnapshot())");
    expect(handler).toContain("setTasks([])");
    expect(handler).toContain("setProjects([])");
    expect(handler).toContain("setFilters(emptyFilters())");
    expect(handler).toContain("setActiveViewId(null)");
    expect(handler).toContain("setTasksLoaded(false)");
  });
});
