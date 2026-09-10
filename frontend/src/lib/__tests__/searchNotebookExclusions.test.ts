import { describe, expect, it } from "vitest";

import { resolveSearchNotebookExclusionStatus } from "../searchNotebookExclusions";

describe("search notebook exclusions", () => {
  const notebooks = [
    { id: "root", parentId: null },
    { id: "child", parentId: "root" },
    { id: "grandchild", parentId: "child" },
    { id: "other", parentId: null },
  ] as any;

  it("distinguishes direct, inherited and included notebooks", () => {
    const exclusions = [{ notebookId: "root", includeDescendants: 1 }];
    expect(resolveSearchNotebookExclusionStatus("root", exclusions, notebooks)).toEqual({
      kind: "direct",
      sourceNotebookId: "root",
    });
    expect(resolveSearchNotebookExclusionStatus("grandchild", exclusions, notebooks)).toEqual({
      kind: "inherited",
      sourceNotebookId: "root",
    });
    expect(resolveSearchNotebookExclusionStatus("other", exclusions, notebooks)).toEqual({
      kind: "included",
      sourceNotebookId: null,
    });
  });

  it("does not inherit a rule whose descendants flag is disabled", () => {
    const exclusions = [{ notebookId: "root", includeDescendants: 0 }];
    expect(resolveSearchNotebookExclusionStatus("root", exclusions, notebooks).kind).toBe("direct");
    expect(resolveSearchNotebookExclusionStatus("child", exclusions, notebooks)).toEqual({
      kind: "included",
      sourceNotebookId: null,
    });
  });

  it("terminates safely when legacy notebook parents contain a cycle", () => {
    const cyclic = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ] as any;
    expect(resolveSearchNotebookExclusionStatus("a", [], cyclic)).toEqual({
      kind: "included",
      sourceNotebookId: null,
    });
  });
});
