/**
 * editorMode.ts 单元测试
 *
 * 覆盖：
 *   - URL `?md=1|0` 强制优先于 localStorage
 *   - localStorage 合法值 / 非法值回落默认
 *   - persistEditorMode 写入 + 读回
 *   - clearForcedModeFromUrl 删 md=，保留其他参数
 *   - nextEditorMode 两向切换
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  EDITOR_MODE_KEY,
  clearForcedModeFromUrl,
  nextEditorMode,
  persistEditorMode,
  resolveEditorMode,
} from "@/lib/editorMode";

function setLocation(url: string) {
  // jsdom 支持通过 history.replaceState 改变 location.search
  window.history.replaceState(null, "", url);
}

beforeEach(() => {
  localStorage.clear();
  setLocation("/");
});

describe("resolveEditorMode", () => {
  it("默认返回 tiptap", () => {
    expect(resolveEditorMode()).toBe("tiptap");
  });

  it("自定义 defaultMode 生效", () => {
    expect(resolveEditorMode("md")).toBe("md");
  });

  it("?md=1 强制 md，忽略 localStorage", () => {
    localStorage.setItem(EDITOR_MODE_KEY, "tiptap");
    setLocation("/?md=1");
    expect(resolveEditorMode()).toBe("md");
  });

  it("?md=0 强制 tiptap，忽略 localStorage", () => {
    localStorage.setItem(EDITOR_MODE_KEY, "md");
    setLocation("/?md=0");
    expect(resolveEditorMode()).toBe("tiptap");
  });

  it("无 URL 强制时读 localStorage", () => {
    localStorage.setItem(EDITOR_MODE_KEY, "md");
    expect(resolveEditorMode()).toBe("md");
    localStorage.setItem(EDITOR_MODE_KEY, "tiptap");
    expect(resolveEditorMode()).toBe("tiptap");
  });

  it("localStorage 非法值回落默认", () => {
    localStorage.setItem(EDITOR_MODE_KEY, "vim"); // 非法
    expect(resolveEditorMode()).toBe("tiptap");
    expect(resolveEditorMode("md")).toBe("md");
  });
});

describe("persistEditorMode", () => {
  it("写入后可被 resolve 读回", () => {
    persistEditorMode("md");
    expect(localStorage.getItem(EDITOR_MODE_KEY)).toBe("md");
    expect(resolveEditorMode()).toBe("md");

    persistEditorMode("tiptap");
    expect(localStorage.getItem(EDITOR_MODE_KEY)).toBe("tiptap");
    expect(resolveEditorMode()).toBe("tiptap");
  });
});

describe("clearForcedModeFromUrl", () => {
  it("清掉 md 参数", () => {
    setLocation("/app?md=1");
    clearForcedModeFromUrl();
    expect(window.location.search).toBe("");
  });

  it("只清 md，其他参数保留", () => {
    setLocation("/app?md=1&foo=bar&baz=1");
    clearForcedModeFromUrl();
    expect(window.location.search).toContain("foo=bar");
    expect(window.location.search).toContain("baz=1");
    expect(window.location.search).not.toContain("md=");
  });

  it("无 md 参数时是 no-op（不抛）", () => {
    setLocation("/app?foo=bar");
    expect(() => clearForcedModeFromUrl()).not.toThrow();
    expect(window.location.search).toBe("?foo=bar");
  });
});

describe("nextEditorMode", () => {
  it("md ↔ tiptap 互换", () => {
    expect(nextEditorMode("md")).toBe("tiptap");
    expect(nextEditorMode("tiptap")).toBe("md");
  });
});
