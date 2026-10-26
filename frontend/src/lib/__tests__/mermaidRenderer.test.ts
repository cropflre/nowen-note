import { beforeAll, expect, test } from "vitest";
import { renderMermaid } from "@/lib/mermaidRenderer";

beforeAll(() => {
  Object.defineProperties(SVGElement.prototype, {
    getBBox: {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 100, height: 40 }),
    },
    getComputedTextLength: {
      configurable: true,
      value: () => 80,
    },
  });

  if (!globalThis.CSSStyleSheet) {
    class CSSStyleSheetMock {
      cssRules: { cssText: string }[] = [];

      insertRule(rule: string) {
        this.cssRules.push({ cssText: rule });
      }
    }
    Object.defineProperty(globalThis, "CSSStyleSheet", { configurable: true, value: CSSStyleSheetMock });
  }
});

test("renders Mermaid node labels as SVG text instead of foreignObject", async () => {
  const result = await renderMermaid("graph TD\nA[开始] --> B[结束]");

  expect(result.error).toBe("");
  expect(result.svg).toContain("<text");
  expect(result.svg).not.toContain("foreignObject");
});

test.each([
  ["the decision label from Issue #887", "flowchart TD\nEL2{迭代次数超限?<br/>(e.g., >2次)} --> Done[结束]", "迭代次数超限?", "(e.g., >2次)"],
  ["parentheses in a rectangular label", "graph LR\nA[调用方法(foo)] --> B[完成]", "调用方法(foo)"],
  ["standalone slash comments", "// 流程说明\nflowchart TD\n  // 分支说明\nA[开始] --> B[结束]", "开始", "结束"],
  ["comments together with parentheses", "flowchart LR\n// 调用 API\nA[调用 API(foo)] --> B{成功(ok)?}", "调用 API(foo)", "成功(ok)?"],
])("renders %s", async (_name, source, ...labels) => {
  const result = await renderMermaid(source);
  expect(result.error).toBe("");
  const svg = new DOMParser().parseFromString(result.svg, "image/svg+xml");
  const text = Array.from(svg.querySelectorAll("text"), (node) => node.textContent).join("\n");
  for (const label of labels) expect(text).toContain(label);
});

test.each([
  ["native shapes and quoted labels", 'flowchart LR\nA(开始) --> B((结束))\nB --> C["方法(foo)"]'],
  ["URLs and slashes in labels", 'flowchart LR\nA["https://example.com/a//b(foo)"] --> B[/输出/]'],
  ["standard comments", "flowchart TD\n%% 说明\nA[开始] --> B[结束]"],
  ["other diagram types", "sequenceDiagram\nAlice->>Bob: 调用(foo) https://example.com"],
])("preserves %s", async (_name, source) => {
  const result = await renderMermaid(source);
  expect(result.error).toBe("");
  expect(result.svg).toContain("<svg");
});

test.each([
  ["[", "]"], ["[[", "]]"], ["[(", ")]"], ["[/", "/]"],
  ["[/", "\\]"], ["[\\", "\\]"], ["[\\", "/]"], ["{", "}"], ["{{", "}}"],
])("preserves the %s %s shape during compatibility rendering", async (open, close) => {
  const compatible = await renderMermaid(`flowchart LR\n// 注释\nA${open}调用(foo)${close}`);
  const standard = await renderMermaid(`flowchart LR\nA${open}"调用(foo)"${close}`);
  expect(compatible.error).toBe("");
  expect(standard.error).toBe("");
  const nodes = [compatible, standard].map(({ svg }) => {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    return doc.querySelector(".nodes .node")!;
  });
  expect(nodes[0].textContent).toBe(nodes[1].textContent);
  expect(nodes[0].firstElementChild?.outerHTML).toBe(nodes[1].firstElementChild?.outerHTML);
});

test("keeps quoted multiline text and URLs literal when retrying", async () => {
  const result = await renderMermaid('flowchart LR\n// 注释\nA["第一行\n// 保留的文字(foo)"] --> B["https://example.com/a//b(foo)"]');
  expect(result.error).toBe("");
  const doc = new DOMParser().parseFromString(result.svg, "image/svg+xml");
  expect(doc.querySelector(".nodes")?.textContent).toContain("// 保留的文字(foo)");
  expect(doc.querySelector(".nodes")?.textContent).toContain("https://example.com/a//b(foo)");
});

test("does not treat a line inside an unquoted node label as a comment", async () => {
  const result = await renderMermaid("flowchart LR\nA[第一行\n// 节点文字] --> B{调用(foo)}");
  expect(result.error).toBe("");
  const doc = new DOMParser().parseFromString(result.svg, "image/svg+xml");
  expect(doc.querySelector(".nodes")?.textContent).toContain("// 节点文字");
});

test("still reports an invalid diagram", async () => {
  const result = await renderMermaid("flowchart TD\n// 注释\nA[未闭合(foo)");
  expect(result.svg).toBe("");
  expect(result.error).not.toBe("");
});
