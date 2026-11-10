import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownPreview } from "@/components/MarkdownPreview";
import { MARKDOWN_SEGMENTED_PREVIEW_THRESHOLD } from "@/lib/markdownPreviewSegments";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/MathView", () => ({
  MathView: ({ source }: { source: string }) => <span>{source}</span>,
}));

const HEARTBEAT = "HeartBeat (The computer needs to send,every 15 seconds,The serial number is subject to the actual,):";
const HEARTBEAT_BODY = 'aaaa{ "SN": "360111504D46303737154929", "Timestamp": "1758937469", "Cmd": "HeartBeat", "MsgData": { "MsgId": "1" } }';

describe("MarkdownPreview 保留源码里的单个换行", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async (markdown: string) => {
    await act(async () => { root.render(<MarkdownPreview markdown={markdown} />); });
  };
  const paragraphs = () => Array.from(host.querySelectorAll("p"));

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("英文示例：冒号行与 JSON 行之间的换行渲染为 <br>，空行仍然分段", async () => {
    await render(["example", "", HEARTBEAT, HEARTBEAT_BODY, "", "Remote door opening(...):", HEARTBEAT_BODY].join("\n"));

    const ps = paragraphs();
    expect(ps).toHaveLength(3);
    expect(ps[0].querySelectorAll("br")).toHaveLength(0);
    expect(ps[1].querySelectorAll("br")).toHaveLength(1);
    expect(ps[1].innerHTML).toContain(`actual,):<br>\naaaa{`);
    expect(ps[1].textContent).toBe(`${HEARTBEAT}\n${HEARTBEAT_BODY}`);
    expect(ps[2].querySelectorAll("br")).toHaveLength(1);
  });

  it("中文示例：相邻两行不会并成一行，空行后的段落独立", async () => {
    await render(["12.1是3.3V供电", "18.5是5V供电", "", "18.5的恒流板，960P是2个电阻（1R00或1R50），1080P是1个电阻（R500）"].join("\n"));

    const ps = paragraphs();
    expect(ps).toHaveLength(2);
    expect(ps[0].querySelectorAll("br")).toHaveLength(1);
    expect(ps[0].innerHTML).toContain("12.1是3.3V供电<br>\n18.5是5V供电");
    expect(ps[1].querySelectorAll("br")).toHaveLength(0);
  });

  it("只有空行分段的文档不产生任何 <br>", async () => {
    await render("段落一\n\n段落二\n\n\n段落三");
    expect(paragraphs()).toHaveLength(3);
    expect(host.querySelectorAll("br")).toHaveLength(0);
  });

  it("围栏代码块内的换行不被处理，代码文本保持原样", async () => {
    await render("前文\n后文\n\n```js\nconst a = 1;\nconst b = 2;\n\nconsole.log(a + b);\n```");

    expect(host.querySelectorAll("br")).toHaveLength(1); // 只有「前文/后文」之间那一个
    expect(paragraphs()[0].querySelectorAll("br")).toHaveLength(1);
    expect(host.querySelector("code")?.textContent).toBe("const a = 1;\nconst b = 2;\n\nconsole.log(a + b);");
  });

  it("行内代码、加粗等行内样式与换行共存", async () => {
    await render("行内 `code` 与 **加粗**\n紧跟的下一行");

    const [p] = paragraphs();
    expect(p.querySelectorAll("br")).toHaveLength(1);
    expect(p.querySelector("code")?.textContent).toBe("code");
    expect(p.querySelector("strong")?.textContent).toBe("加粗");
  });

  it("无序、有序列表与任务列表的续行保留换行，列表结构不变", async () => {
    await render([
      "- 列表项一", "  续行文字", "- 列表项二",
      "",
      "1. 有序一", "   有序一的续行", "2. 有序二",
      "",
      "- [ ] 任务一", "  任务续行", "- [x] 任务二",
    ].join("\n"));

    const items = Array.from(host.querySelectorAll("li"));
    expect(items).toHaveLength(6);
    expect(host.querySelectorAll("ul")).toHaveLength(2);
    expect(host.querySelectorAll("ol")).toHaveLength(1);
    expect(items.map((item) => item.querySelectorAll("br").length)).toEqual([1, 0, 1, 0, 1, 0]);
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(items[5].getAttribute("data-checked")).toBe("true");
  });

  it("表格不产生 <br>，行列结构不变", async () => {
    await render("| 列A | 列B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |");

    expect(host.querySelectorAll("table tr")).toHaveLength(3);
    expect(host.querySelectorAll("td")).toHaveLength(4);
    expect(host.querySelectorAll("br")).toHaveLength(0);
  });

  it("引用与 Callout 的多行正文保留换行，Callout 标记行仍被识别", async () => {
    await render("> 引用第一行\n> 引用第二行\n\n> [!NOTE] 提示标题\n> 提示正文第一行\n> 提示正文第二行");

    const [quote, callout] = Array.from(host.querySelectorAll("blockquote"));
    expect(quote.querySelectorAll("br")).toHaveLength(1);
    expect(callout.textContent).toContain("提示标题");
    expect(callout.textContent).not.toContain("[!NOTE]");
    expect(callout.querySelectorAll("br")).toHaveLength(1);
    expect(callout.innerHTML).toContain("提示正文第一行<br>\n提示正文第二行");
  });

  it("硬换行与行尾手写 <br> 不会重复换行", async () => {
    await render(["两个空格  ", "下一行", "", "反斜杠\\", "下一行", "", "显式 br<br>", "下一行", "", "显式 br 自闭合<br />", "下一行"].join("\n"));

    expect(paragraphs().map((p) => p.querySelectorAll("br").length)).toEqual([1, 1, 1, 1]);
  });

  it("超过分段阈值的长文档同样保留换行", async () => {
    const block = `${"甲".repeat(60)}\n${"乙".repeat(60)}\n\n`;
    const count = Math.ceil(MARKDOWN_SEGMENTED_PREVIEW_THRESHOLD / block.length) + 10;
    await render(block.repeat(count));

    expect(host.querySelectorAll("[data-markdown-segment]").length).toBeGreaterThan(1);
    expect(host.querySelectorAll("p")).toHaveLength(count);
    expect(host.querySelectorAll("br")).toHaveLength(count);
  });
});
