import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PptDocumentEditor from "@/components/PptDocumentEditor";
import type { Note } from "@/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  api: {
    attachments: {
      upload: vi.fn(),
    },
  },
  getBaseUrl: () => "/api",
}));

function setControlValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function makePptNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "ppt-note-1",
    userId: "u1",
    notebookId: "nb1",
    workspaceId: null,
    title: "测试演示文稿",
    content: "{}",
    contentText: "",
    contentFormat: "ppt-json",
    noteType: "ppt",
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 0,
    trashedAt: null,
    version: 1,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("PptDocumentEditor 无障碍幻灯片编辑器", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("支持默认双页初始化、新增/切换版式、大纲生成与全屏放映键盘翻页", async () => {
    const onUpdate = vi.fn();
    const onHeadingsChange = vi.fn();

    await act(async () => {
      root.render(
        <PptDocumentEditor
          note={makePptNote()}
          onUpdate={onUpdate}
          onHeadingsChange={onHeadingsChange}
          editable
        />,
      );
    });

    // 默认初始化为 2 页幻灯片，且大纲同步回调收到 2 项
    expect(host.querySelectorAll('[role="option"]').length).toBe(2);
    expect(onHeadingsChange).toHaveBeenCalled();

    // 点击新建页 → 变为 3 页
    const addBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("新建页"),
    );
    expect(addBtn).toBeTruthy();
    await act(async () => addBtn!.click());
    expect(host.querySelectorAll('[role="option"]').length).toBe(3);

    // 切换当前页版式为「引用金句」
    const layoutSelect = host.querySelector<HTMLSelectElement>('select[aria-label="选择当前页版式"]');
    expect(layoutSelect).toBeTruthy();
    await act(async () => setControlValue(layoutSelect!, "quote"));
    expect(host.querySelector('[data-ppt-layout="quote"]')).toBeTruthy();

    // 开启无障碍高对比模式
    const contrastBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("无障碍"),
    );
    expect(contrastBtn).toBeTruthy();
    await act(async () => contrastBtn!.click());
    expect(host.querySelector('.ppt-editor-root[data-high-contrast="true"]')).toBeTruthy();
    expect(host.querySelector('[data-ppt-theme="high-contrast"]')).toBeTruthy();

    // 进入全屏放映并用方向键翻页、Esc 退出
    const presentBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "放映",
    );
    expect(presentBtn).toBeTruthy();
    await act(async () => presentBtn!.click());

    const overlay = document.body.querySelector('[aria-label="PPT 全屏放映模式"]');
    expect(overlay).toBeTruthy();
    expect(overlay!.textContent).toContain("2 / 3");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    expect(overlay!.textContent).toContain("3 / 3");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.body.querySelector('[aria-label="PPT 全屏放映模式"]')).toBeNull();
  });
});
