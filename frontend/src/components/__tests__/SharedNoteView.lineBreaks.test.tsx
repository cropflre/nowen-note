import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({ siteConfig: { shareFooterText: "", sharePageWidth: "standard", shareBannerEnabled: false, shareBannerImage: "" } }),
}));
vi.mock("@/components/TiptapEditor", () => ({ default: () => null }));

import { api } from "@/lib/api";
import SharedNoteView from "../SharedNoteView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("分享页保留 Markdown 源码里的单个换行", () => {
  let host: HTMLDivElement;
  let root: Root;

  const renderShared = async (content: string) => {
    vi.mocked(api.getSharedContent).mockResolvedValue({
      title: "分享测试", content, contentText: content, contentFormat: "markdown", permission: "view",
      updatedAt: "2026-11-08T00:00:00Z", version: 1,
    });
    await act(async () => root.render(<SharedNoteView shareToken="test-token" />));
    const body = host.querySelector<HTMLElement>(".shared-note-content");
    expect(body).not.toBeNull();
    return body!;
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(api, "getMe").mockRejectedValue(new Error("未登录"));
    vi.spyOn(api, "getShareInfo").mockResolvedValue({
      id: "share-1", noteTitle: "分享测试", permission: "view", needPassword: false,
      ownerName: "作者", expiresAt: null, createdAt: "2026-11-08T00:00:00Z",
    });
    vi.spyOn(api, "getSharedContent");
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("相邻两行渲染为 <br>，空行仍然分段", async () => {
    const body = await renderShared("12.1是3.3V供电\n18.5是5V供电\n\n18.5的恒流板，960P是2个电阻（1R00或1R50）");

    const ps = Array.from(body.querySelectorAll("p"));
    expect(ps).toHaveLength(2);
    expect(ps[0].innerHTML).toBe("12.1是3.3V供电<br>\n18.5是5V供电");
    expect(ps[1].querySelectorAll("br")).toHaveLength(0);
  });

  it("冒号行与 JSON 行之间的换行保留", async () => {
    const heartbeat = "HeartBeat (The computer needs to send,every 15 seconds,The serial number is subject to the actual,):";
    const json = 'aaaa{ "SN": "360111504D46303737154929", "Cmd": "HeartBeat", "MsgData": { "MsgId": "1" } }';
    const body = await renderShared(`example\n\n${heartbeat}\n${json}`);

    const ps = Array.from(body.querySelectorAll("p"));
    expect(ps).toHaveLength(2);
    expect(ps[1].querySelectorAll("br")).toHaveLength(1);
    expect(ps[1].textContent).toBe(`${heartbeat}\n${json}`);
  });

  it("围栏代码块、列表、表格与引用不受影响", async () => {
    const body = await renderShared([
      "- 列表项一", "  续行文字", "- 列表项二",
      "",
      "> 引用第一行", "> 引用第二行",
      "",
      "| 列A | 列B |", "| --- | --- |", "| a1 | b1 |",
      "",
      "```js", "const a = 1;", "const b = 2;", "```",
    ].join("\n"));

    const items = Array.from(body.querySelectorAll("li"));
    expect(items.map((item) => item.querySelectorAll("br").length)).toEqual([1, 0]);
    expect(body.querySelectorAll("blockquote br")).toHaveLength(1);
    expect(body.querySelectorAll("table tr")).toHaveLength(2);
    expect(body.querySelectorAll("table br")).toHaveLength(0);
    expect(body.querySelectorAll("pre br")).toHaveLength(0);
    expect(body.querySelector("pre code")?.textContent).toBe("const a = 1;\nconst b = 2;\n");
    expect(body.querySelectorAll("br")).toHaveLength(2);
  });

  it("行尾手写 <br> 与硬换行不会重复换行", async () => {
    const body = await renderShared(["显式 br<br>", "下一行", "", "两个空格  ", "下一行"].join("\n"));

    expect(Array.from(body.querySelectorAll("p")).map((p) => p.querySelectorAll("br").length)).toEqual([1, 1]);
  });
});
