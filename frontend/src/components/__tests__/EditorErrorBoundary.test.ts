import { describe, expect, it } from "vitest";
import { getEditorErrorPresentation } from "../EditorErrorBoundary";

describe("getEditorErrorPresentation", () => {
  it("does not mislabel findLast runtime failures as note corruption", () => {
    const presentation = getEditorErrorPresentation(
      new TypeError("n.findLast is not a function"),
    );

    expect(presentation.description).toContain("Android WebView");
    expect(presentation.description).toContain("升级 APP");
    expect(presentation.hint).toContain("不代表笔记正文损坏");
  });

  it("keeps the structural-content guidance for genuine editor document failures", () => {
    const presentation = getEditorErrorPresentation(
      new Error("Called contentMatchAt on a node with invalid content"),
    );

    expect(presentation.description).toContain("内容结构异常");
    expect(presentation.description).not.toContain("Android WebView");
  });
});
