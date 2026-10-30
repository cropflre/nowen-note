import { describe, expect, it } from "vitest";
import { assertNativePersonalTreeEntry } from "../nativeKnowledgeTreeSync";

const entry = {
  id: "note:root-note", resourceType: "note", resourceId: "root-note",
  userId: "owner", workspaceId: null, parentId: null, nodeType: "note",
  sortOrder: -2147483647, isDeleted: 0, deletedAt: null,
  createdAt: "2026-10-15", updatedAt: "2026-10-15",
};

describe("Native tree root ordering", () => {
  it("accepts signed positions generated beside the hidden root-document container", () => {
    expect(() => assertNativePersonalTreeEntry(entry.id, entry, "owner")).not.toThrow();
  });

  it.each([0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid numeric positions: %s", (sortOrder) => {
    expect(() => assertNativePersonalTreeEntry(entry.id, { ...entry, sortOrder }, "owner"))
      .toThrow("知识树资源身份、作用域或结构字段无效");
  });
});
