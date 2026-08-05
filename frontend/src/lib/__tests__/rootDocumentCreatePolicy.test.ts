import { describe, expect, it } from "vitest";

import {
  buildRootDocumentFollowupPatch,
  isRootDocumentNotebookId,
  resolveRootDocumentNodeType,
  resolveRootDocumentTitle,
  rootDocumentCreateRequestKey,
} from "@/lib/rootDocumentCreatePolicy";

describe("root document create policy", () => {
  it("recognizes only internal root-document notebook ids", () => {
    expect(isRootDocumentNotebookId("__nowen_root_documents__:personal:user-1")).toBe(true);
    expect(isRootDocumentNotebookId("__nowen_root_documents__:workspace:ws-1")).toBe(true);
    expect(isRootDocumentNotebookId("normal-notebook-id")).toBe(false);
    expect(isRootDocumentNotebookId(null)).toBe(false);
  });

  it("maps hidden-container creates back to supported root node types", () => {
    expect(resolveRootDocumentNodeType({ contentFormat: "markdown" })).toBe("markdown");
    expect(resolveRootDocumentNodeType({ contentFormat: "tiptap-json" })).toBe("note");
    expect(resolveRootDocumentTitle({ contentFormat: "markdown" })).toBe("无标题 Markdown");
    expect(resolveRootDocumentTitle({ title: "  根级文档  " })).toBe("根级文档");
  });

  it("deduplicates identical root create requests with a stable key", () => {
    const input = {
      notebookId: "__nowen_root_documents__:personal:user-1",
      title: "无标题笔记",
      contentFormat: "tiptap-json",
    };
    expect(rootDocumentCreateRequestKey(input)).toBe(rootDocumentCreateRequestKey({ ...input }));
    expect(rootDocumentCreateRequestKey(input)).not.toBe(rootDocumentCreateRequestKey({
      ...input,
      title: "另一篇笔记",
    }));
  });

  it("preserves explicit Markdown content after knowledge-tree creation", () => {
    expect(buildRootDocumentFollowupPatch({
      title: "无标题 Markdown",
      content: "# 无标题 Markdown\n\n",
      contentFormat: "markdown",
    }, {
      title: "无标题 Markdown",
      content: "# 自定义正文\n\n内容",
      contentText: "自定义正文 内容",
      contentFormat: "markdown",
    })).toEqual({
      content: "# 自定义正文\n\n内容",
      contentText: "自定义正文 内容",
      syncToYjs: true,
    });
  });
});
