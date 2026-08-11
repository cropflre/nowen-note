// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: {
    activeNote: null as null | Record<string, unknown>,
    notebooks: [],
  },
  editorPaneProps: null as null | {
    canSplitDocument?: boolean;
    onSplitDocument?: () => void;
  },
}));

vi.mock("../FormatAwareEditorPane", () => ({
  default: (props: {
    canSplitDocument?: boolean;
    onSplitDocument?: () => void;
  }) => {
    mocks.editorPaneProps = props;
    return <div data-testid="editor-pane" />;
  },
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: mocks.state }),
  useAppActions: () => ({}),
}));

vi.mock("@/lib/notePermissions", () => ({
  canWriteNote: () => true,
}));

vi.mock("@/components/NoteSplitDialog", () => ({
  default: ({ open }: { open: boolean }) => open
    ? <div data-testid="note-split-dialog" />
    : null,
}));

import EditorPaneRuntime from "../EditorPaneRuntime";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
  mocks.state.activeNote = null;
  mocks.editorPaneProps = null;
  document.body.innerHTML = "";
});

describe("EditorPaneRuntime layout", () => {
  it("keeps the wrapped editor inside a shrinkable flex viewport", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(<EditorPaneRuntime />));

      const shell = host.firstElementChild;
      expect(shell).not.toBeNull();
      expect([...shell!.classList]).toEqual(expect.arrayContaining([
        "flex",
        "h-full",
        "min-h-0",
        "flex-col",
        "overflow-hidden",
      ]));
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("defers split analysis until after the first render, then delegates the action", async () => {
    vi.useFakeTimers();
    mocks.state.activeNote = {
      id: "split-note",
      title: "可拆分笔记",
      contentFormat: "markdown",
      content: "# 标题\n\n## 第一章\n\n正文\n\n## 第二章\n\n正文",
      contentText: "标题 第一章 正文 第二章 正文",
      updatedAt: "2026-07-31T00:00:00.000Z",
      version: 1,
      isLocked: false,
      isTrashed: false,
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(<EditorPaneRuntime />));

      // The optional heading scan must not block the note's initial editor render.
      expect(mocks.editorPaneProps?.canSplitDocument).toBe(false);

      await act(async () => {
        vi.runAllTimers();
      });

      expect(mocks.editorPaneProps?.canSplitDocument).toBe(true);
      expect(host.textContent).not.toContain("拆分文档");

      await act(async () => mocks.editorPaneProps?.onSplitDocument?.());

      expect(host.querySelector('[data-testid="note-split-dialog"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
