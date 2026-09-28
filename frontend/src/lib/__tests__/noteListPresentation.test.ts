import { describe, expect, it } from "vitest";
import { compactNotebookLabels, noteListPreview, noteListRowHeight } from "../noteListPresentation";

const labels = { mindmap: "思维导图", diagram: "流程图" };

describe("compact note list presentation", () => {
  it("summarizes embeds and removes generated anchors without changing prose", () => {
    expect(noteListPreview("说明 ![[mindmap:1942078ddf6347aabf300793986cda74]] ^blke3e70828a07e4148a5367fa23066a776 后续正文", labels)).toBe("说明 思维导图 后续正文");
    expect(noteListPreview("![[mindmap:11111111-1111-4111-8111-111111111111]]", labels)).toBe("思维导图");
  });
  it("summarizes fenced Mermaid while preserving surrounding text", () => {
    expect(noteListPreview("项目\n```mermaid\ngraph TD\n A-->B\n```\n计划", labels)).toBe("项目 流程图 计划");
    expect(noteListPreview("```mermaid\nmindmap\n root((主题))\n```", labels)).toBe("思维导图");
  });
  it("handles rich-text diagram plainText and leaves ordinary code alone", () => {
    expect(noteListPreview("graph TD A[开始] --> B[结束]", labels)).toBe("流程图");
    expect(noteListPreview("mindmap root((主题)) 子主题", labels)).toBe("思维导图");
    expect(noteListPreview("const graph = 1; ^my-user-anchor", labels)).toBe("const graph = 1; ^my-user-anchor");
  });
  it("normalizes whitespace and limits ordinary summaries", () => {
    expect(noteListPreview("第一行\n\n第二行", labels)).toBe("第一行 第二行");
    expect(noteListPreview("长".repeat(300), labels)).toHaveLength(160);
    expect(noteListPreview("", labels)).toBe("");
  });
  it("uses a leaf name for unique folders and parent suffixes for same-name folders", () => {
    const paths = new Map([
      ["a", "公司 / 项目A / 资料"], ["b", "公司 / 项目B / 资料"], ["c", "公司 / 项目C / 草稿"],
    ]);
    const compact = compactNotebookLabels(paths);
    expect(compact.get("a")).toEqual({ text: "项目A / 资料", path: paths.get("a") });
    expect(compact.get("b")?.text).toBe("项目B / 资料");
    expect(compact.get("c")?.text).toBe("草稿");
  });
  it("disambiguates deep suffix collisions and tolerates identical full paths", () => {
    const compact = compactNotebookLabels(new Map([
      ["a", "工作 / 归档 / 资料"], ["b", "个人 / 归档 / 资料"], ["c", "个人 / 归档 / 资料"],
    ]));
    expect(compact.get("a")?.text).toBe("工作 / 归档 / 资料");
    expect(compact.get("b")?.text).toBe("个人 / 归档 / 资料");
  });
  it("shares row geometry across ordinary, title-only and search lists", () => {
    expect(noteListRowHeight(false)).toBe(80);
    expect(noteListRowHeight(true)).toBe(40);
    expect(noteListRowHeight(true, "命中")).toBe(124);
    expect(noteListRowHeight(false, "命中")).toBe(124);
  });
});
