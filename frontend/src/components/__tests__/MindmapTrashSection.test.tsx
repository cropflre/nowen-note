// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listForWorkspace, restore, removePermanently, confirm } = vi.hoisted(() => ({
  listForWorkspace: vi.fn(),
  restore: vi.fn(),
  removePermanently: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("@/lib/knowledgeTreeApi", () => ({ knowledgeTreeApi: { listForWorkspace, restore } }));
vi.mock("@/lib/api", () => ({ api: { deleteMindMapPermanently: removePermanently } }));
vi.mock("@/components/ui/confirm", () => ({ confirm }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/workspaceRefreshBridge", () => ({ emitKnowledgeTreeRefresh: vi.fn() }));

import MindmapTrashSection from "@/components/MindmapTrashSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MindmapTrashSection", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    confirm.mockResolvedValue(true);
    restore.mockResolvedValue({ success: true, restoredNodeIds: ["folder", "map"] });
    removePermanently.mockResolvedValue({ success: true });
    listForWorkspace.mockResolvedValue({ nodes: [
      { id: "folder", parentId: null, resourceType: "notebook", resourceId: "nb", title: "项目", isDeleted: 1 },
      { id: "map", parentId: "folder", resourceType: "mindmap", resourceId: "map-id", title: "设计", isDeleted: 1,
        access: { capabilities: { canDelete: true } } },
      { id: "active-map", parentId: null, resourceType: "mindmap", resourceId: "other", title: "仍在使用", isDeleted: 0 },
    ] });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("lists only trashed mindmaps and restores their deleted parent cohort", async () => {
    const onCountChange = vi.fn();
    await act(async () => {
      root.render(<MindmapTrashSection workspaceId="personal" onCountChange={onCountChange} />);
      await Promise.resolve();
    });
    expect(listForWorkspace).toHaveBeenCalledWith("personal", true);
    expect(onCountChange).toHaveBeenCalledWith(1);
    expect(host.textContent).toContain("设计");
    expect(host.textContent).not.toContain("仍在使用");

    await act(async () => {
      (host.querySelector('[aria-label="恢复设计"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledWith("folder");
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("restores a mindmap separately when it was deleted before its parent folder", async () => {
    restore.mockResolvedValueOnce({ success: true, restoredNodeIds: ["folder"] })
      .mockResolvedValueOnce({ success: true, restoredNodeIds: ["map"] });
    await act(async () => {
      root.render(<MindmapTrashSection workspaceId="personal" onCountChange={vi.fn()} />);
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('[aria-label="恢复设计"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(restore.mock.calls.map(([id]) => id)).toEqual(["folder", "map"]);
  });

  it("requires confirmation before permanently deleting a trashed map", async () => {
    await act(async () => {
      root.render(<MindmapTrashSection workspaceId="personal" onCountChange={vi.fn()} />);
      await Promise.resolve();
    });
    await act(async () => {
      (host.querySelector('[aria-label="永久删除设计"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(removePermanently).toHaveBeenCalledWith("map-id");
  });
});
