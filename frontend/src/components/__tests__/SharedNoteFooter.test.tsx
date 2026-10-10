import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ footerText: "" }));
vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({ siteConfig: { shareFooterText: mocks.footerText } }),
}));
vi.mock("@/components/TiptapEditor", () => ({ default: () => null }));

import { api } from "@/lib/api";
import SharedNoteView from "../SharedNoteView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("分享页底部标识", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(api, "getMe").mockRejectedValue(new Error("未登录"));
    vi.spyOn(api, "getShareInfo").mockResolvedValue({
      id: "share-1", noteTitle: "分享测试", permission: "view", needPassword: false,
      ownerName: "作者", expiresAt: null, createdAt: "2026-10-08T00:00:00Z",
    });
    vi.spyOn(api, "getSharedContent").mockResolvedValue({
      title: "分享测试", content: "正文", contentText: "正文", contentFormat: "markdown", permission: "view",
      updatedAt: "2026-10-08T00:00:00Z", version: 1,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it.each(["", "   "])("空文字 %j 显示默认标识", async (text) => {
    mocks.footerText = text;
    await act(async () => root.render(<SharedNoteView shareToken="test-token" />));
    expect(host.querySelector("footer")?.textContent).toBe("通过 Nowen Note 分享");
  });

  it("自定义文字按纯文本显示，清空后恢复默认", async () => {
    mocks.footerText = "  <img src=x onerror=alert(1)> 团队知识库  ";
    await act(async () => root.render(<SharedNoteView shareToken="test-token" />));
    const footer = host.querySelector("footer")!;
    expect(footer.textContent).toBe("<img src=x onerror=alert(1)> 团队知识库");
    expect(footer.querySelector("img")).toBeNull();
    mocks.footerText = "";
    await act(async () => root.render(<SharedNoteView shareToken="test-token" />));
    expect(footer.textContent).toBe("通过 Nowen Note 分享");
  });
});
