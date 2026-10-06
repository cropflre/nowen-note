import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeTreeCreateDropdown } from "../KnowledgeTreeCreateMenuRuntime";
import { KNOWLEDGE_TREE_CLEAR_SEARCH_EVENT } from "@/lib/knowledgeTreeCreateVisibility";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mock = vi.hoisted(() => ({ resolve: vi.fn(), duplicate: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("../KnowledgeTreePanel", () => ({ default: () => null, FOCUS_KNOWLEDGE_TREE_EVENT: "nowen:focus-knowledge-tree", KNOWLEDGE_TREE_CHANGED_EVENT: "nowen:knowledge-tree-changed" }));
vi.mock("@/lib/knowledgeTreeDuplicateAsChild", () => ({ resolveDuplicableKnowledgeTreeNote: mock.resolve, duplicateKnowledgeTreeNoteAsChild: mock.duplicate }));
vi.mock("@/lib/toast", () => ({ toast: { success: mock.success, error: mock.error } }));

describe("knowledge tree child duplicate menu", () => {
  let root: Root;
  let host: HTMLDivElement;
  let reveal: ReturnType<typeof vi.fn>;
  let changed: ReturnType<typeof vi.fn>;
  const close = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mock.resolve.mockResolvedValue({ id: "source" });
    mock.duplicate.mockResolvedValue({ treeNodeId: "copy", treeParentId: "source" });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    reveal = vi.fn();
    changed = vi.fn();
    window.addEventListener(KNOWLEDGE_TREE_CLEAR_SEARCH_EVENT, reveal);
    window.addEventListener("nowen:knowledge-tree-changed", changed);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.removeEventListener(KNOWLEDGE_TREE_CLEAR_SEARCH_EVENT, reveal);
    window.removeEventListener("nowen:knowledge-tree-changed", changed);
  });

  async function render() {
    await act(async () => root.render(<KnowledgeTreeCreateDropdown
      menu={{ parentId: "source", anchor: new DOMRect(10, 10, 20, 20) }}
      onClose={close} onCreate={vi.fn()} onCreateFromTemplate={vi.fn()} onImport={vi.fn()}
    />));
    return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((button) => button.textContent === "创建副本");
  }

  it("passes the new node ID to reveal, refreshes and shows success", async () => {
    const button = await render();
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(mock.duplicate).toHaveBeenCalledWith("source");
    expect(close).toHaveBeenCalledTimes(1);
    expect(reveal.mock.calls[0][0].detail).toEqual({ parentId: "source", nodeId: "copy" });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(mock.success).toHaveBeenCalledWith("副本已创建到子目录");
  });

  it("shows a server failure without emitting success or navigation", async () => {
    mock.duplicate.mockRejectedValue(new Error("权限已撤销"));
    const button = await render();
    await act(async () => button!.click());
    expect(mock.error).toHaveBeenCalledWith("权限已撤销");
    expect(reveal).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(mock.success).not.toHaveBeenCalled();
  });

  it("hides child duplication when the source cannot create children", async () => {
    mock.resolve.mockResolvedValue(null);
    expect(await render()).toBeUndefined();
    expect(mock.duplicate).not.toHaveBeenCalled();
  });
});
