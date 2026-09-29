import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types";
import { buildTextCommentAnchor } from "@/lib/inlineCommentAnchor";
import { openInlineCommentPanel, closeInlineCommentPanel } from "@/lib/inlineCommentEvents";

const mocks = vi.hoisted(() => ({ getNote: vi.fn(), getNoteComments: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { getNote: mocks.getNote, getNoteComments: mocks.getNoteComments } }));
vi.mock("@/lib/mobileLocalMode", () => ({ isMobileLocalMode: () => false }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import InlineCommentBridge from "../InlineCommentBridge";

const note = {
  id: "viewport-note", title: "手机笔记", content: "正文", contentText: "正文",
  contentFormat: "markdown", permission: "write",
} as Note;

describe("评论与批注的键盘避让", () => {
  let root: Root;
  let host: HTMLDivElement;
  let viewport: EventTarget & { height: number; width: number; offsetTop: number; offsetLeft: number };

  async function settle() {
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  }
  function overlay() {
    return document.querySelector<HTMLElement>(".nowen-inline-comment-panel")!.parentElement!;
  }
  async function open(annotation = false) {
    await act(async () => {
      root.render(<InlineCommentBridge />);
    });
    // 首次挂载的事件订阅在 effect 中安装。
    await act(async () => { openInlineCommentPanel({ noteId: note.id, anchor: annotation ? buildTextCommentAnchor({
      editor: "markdown", documentText: "正文", start: 0, end: 2,
    }) : null }); });
    await settle();
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("innerWidth", 390);
    viewport = Object.assign(new EventTarget(), { height: 800, width: 390, offsetTop: 0, offsetLeft: 0 });
    vi.stubGlobal("visualViewport", viewport);
    mocks.getNote.mockResolvedValue(note);
    mocks.getNoteComments.mockResolvedValue([]);
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.documentElement.style.removeProperty("--keyboard-height");
    document.documentElement.removeAttribute("data-keyboard");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([false, true])("手机浏览器键盘缩小视口后保留输入区和发送按钮（批注：%s）", async (annotation) => {
    await open(annotation);
    viewport.height = 450;
    viewport.offsetTop = 30;
    viewport.dispatchEvent(new Event("resize"));
    await settle();
    expect(overlay().style.top).toBe("30px");
    expect(overlay().style.height).toBe("450px");
    expect(document.querySelector("textarea")?.placeholder).toBe(annotation ? "输入批注…" : "输入评论…");
    expect(document.querySelector('button[title="发送（Ctrl+Enter）"]')).not.toBeNull();
    viewport.height = 800;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
    await settle();
    expect(overlay().style.height).toBe("800px");
  });

  it.each([true, false])("Android 覆盖模式避让原生键盘并恢复（visualViewport：%s）", async (hasViewport) => {
    if (!hasViewport) vi.stubGlobal("visualViewport", undefined);
    await open();
    document.documentElement.dataset.keyboard = "open";
    document.documentElement.style.setProperty("--keyboard-height", "320px");
    await settle();
    expect(overlay().style.height).toBe("480px");
    viewport.height = 480;
    viewport.dispatchEvent(new Event("resize"));
    await settle();
    expect(overlay().style.height).toBe("480px");
    document.documentElement.removeAttribute("data-keyboard");
    document.documentElement.style.setProperty("--keyboard-height", "0px");
    viewport.height = 800;
    viewport.dispatchEvent(new Event("resize"));
    await settle();
    expect(overlay().style.height).toBe("800px");
  });

  it("横屏小高度下仅滚动输入区，让聚焦的批注输入框保持可达", async () => {
    await open(true);
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;
    const footer = textarea.closest("footer")!;
    Object.defineProperty(footer, "scrollHeight", { configurable: true, value: 300 });
    await act(async () => textarea.focus());
    expect(footer.scrollTop).toBe(300);
    footer.scrollTop = 0;
    viewport.height = 240;
    viewport.dispatchEvent(new Event("resize"));
    await settle();
    expect(footer.scrollTop).toBe(300);
    expect(document.body.scrollTop).toBe(0);
  });

  it("关闭面板后不再订阅视口变化，重新打开读取最新尺寸", async () => {
    const remove = vi.spyOn(viewport, "removeEventListener");
    await open();
    await act(async () => closeInlineCommentPanel());
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
    viewport.height = 400;
    await act(async () => openInlineCommentPanel({ noteId: note.id }));
    await settle();
    expect(overlay().style.height).toBe("400px");
  });
});
