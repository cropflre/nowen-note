import { describe, expect, it } from "vitest";
import type { Notebook } from "@/types";
import {
  getNotebookExpansionChanges,
  getNextNotebookExpansionState,
} from "@/lib/notebookExpansion";

const notebook = (id: string, isExpanded: number): Notebook => ({
  id,
  userId: "user-1",
  workspaceId: null,
  parentId: null,
  name: id,
  description: null,
  icon: "📒",
  color: null,
  sortOrder: 0,
  isExpanded,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("getNotebookExpansionChanges", () => {
  it("returns only notebooks whose expanded state changes", () => {
    const notebooks = [notebook("open", 1), notebook("closed", 0)];

    const result = getNotebookExpansionChanges(notebooks, 1);

    expect(result.changed.map((nb) => nb.id)).toEqual(["closed"]);
    expect(result.nextNotebooks.map((nb) => nb.isExpanded)).toEqual([1, 1]);
  });

  it("keeps original object references for notebooks already in the target state", () => {
    const open = notebook("open", 1);
    const closed = notebook("closed", 0);

    const result = getNotebookExpansionChanges([open, closed], 0);

    expect(result.changed).toEqual([open]);
    expect(result.nextNotebooks[0]).toEqual({ ...open, isExpanded: 0 });
    expect(result.nextNotebooks[1]).toBe(closed);
  });
});

describe("getNextNotebookExpansionState", () => {
  it("collapses all when any notebook is expanded", () => {
    expect(getNextNotebookExpansionState([notebook("open", 1), notebook("closed", 0)])).toBe(0);
  });

  it("expands all when every notebook is collapsed", () => {
    expect(getNextNotebookExpansionState([notebook("closed-1", 0), notebook("closed-2", 0)])).toBe(1);
  });
});
