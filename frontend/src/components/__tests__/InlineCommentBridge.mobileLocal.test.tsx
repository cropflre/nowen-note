// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types";

const mocks = vi.hoisted(() => ({
  createNote: vi.fn(),
  getNote: vi.fn(),
  getNoteComments: vi.fn(),
  updateNote: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    createNote: mocks.createNote,
    getNote: mocks.getNote,
    getNoteComments: mocks.getNoteComments,
    updateNote: mocks.updateNote,
  },
}));

vi.mock("@/lib/mobileLocalMode", () => ({
  isMobileLocalMode: () => true,
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { api } from "@/lib/api";
import InlineCommentBridge from "../InlineCommentBridge";

const NOTE: Note = {
  id: "local-note-1",
  userId: "android-local-user",
  notebookId: "local-notebook-1",
  workspaceId: null,
  title: "本地笔记",
  content: "",
  contentText: "",
  contentFormat: "tiptap-json",
  isPinned: 0,
  isFavorite: 0,
  isLocked: 0,
  isArchived: 0,
  isTrashed: 0,
  trashedAt: null,
  version: 1,
  sortOrder: 0,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

describe("InlineCommentBridge Android 本地模式", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    mocks.createNote.mockReset().mockResolvedValue(NOTE);
    mocks.getNote.mockReset().mockResolvedValue(NOTE);
    mocks.getNoteComments.mockReset().mockResolvedValue([]);
    mocks.updateNote.mockReset().mockResolvedValue(NOTE);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(callback, 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("创建本地笔记后不请求远端评论接口", async () => {
    await act(async () => {
      root.render(<InlineCommentBridge />);
    });

    await act(async () => {
      await (api as typeof api).createNote({ title: "本地笔记" });
    });

    expect(mocks.getNoteComments).not.toHaveBeenCalled();
  });
});
