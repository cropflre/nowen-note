// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getMindMaps, createMindMap } = vi.hoisted(() => ({
  getMindMaps: vi.fn(),
  createMindMap: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: { getMindMaps, createMindMap } }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));

import MindMapEmbedInsertDialog from "@/components/MindMapEmbedInsertDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("MindMapEmbedInsertDialog scope", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    getMindMaps.mockReset();
    createMindMap.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  it("lists and creates maps in the note workspace, not the active navigation scope", async () => {
    const workspaceId = "workspace-1";
    const onInsert = vi.fn(() => true);
    const onClose = vi.fn();
    getMindMaps.mockResolvedValue([
      { id: "workspace-map", workspaceId, title: "团队导图" },
      { id: "personal-map", workspaceId: null, title: "个人导图" },
    ]);
    createMindMap.mockResolvedValue({ id: "new-workspace-map" });

    await act(async () => {
      root.render(<MindMapEmbedInsertDialog open workspaceId={workspaceId} onClose={onClose} onInsert={onInsert} />);
      await Promise.resolve();
    });

    expect(getMindMaps).toHaveBeenCalledWith(workspaceId);
    expect(document.body.textContent).toContain("团队导图");
    expect(document.body.textContent).not.toContain("个人导图");

    const createButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("新建并插入"),
    );
    await act(async () => {
      createButton?.click();
      await Promise.resolve();
    });

    expect(createMindMap).toHaveBeenCalledWith({ title: "无标题导图" }, workspaceId);
    expect(onInsert).toHaveBeenCalledWith("new-workspace-map");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("passes an explicit personal scope even if navigation is in a workspace", async () => {
    getMindMaps.mockResolvedValue([]);
    await act(async () => {
      root.render(<MindMapEmbedInsertDialog open workspaceId={null} onClose={vi.fn()} onInsert={vi.fn()} />);
      await Promise.resolve();
    });
    expect(getMindMaps).toHaveBeenCalledWith(null);
  });
});
