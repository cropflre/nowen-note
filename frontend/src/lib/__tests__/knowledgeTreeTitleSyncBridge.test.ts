import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installKnowledgeTreeTitleSyncBridge,
  KNOWLEDGE_TREE_CHANGED_EVENT,
  type KnowledgeTreeTitleSyncApi,
} from "@/lib/knowledgeTreeTitleSyncBridge";

function createApi(initialTitle = "旧标题") {
  return {
    getNote: vi.fn(async (id: string) => ({
      id,
      title: initialTitle,
      contentText: "正文",
      updatedAt: "2026-07-31T08:00:00.000Z",
    })),
    updateNote: vi.fn(async (id: string, payload: Record<string, unknown>) => ({
      id,
      title: typeof payload.title === "string" ? payload.title : initialTitle,
      contentText: typeof payload.contentText === "string" ? payload.contentText : "正文",
      updatedAt: "2026-07-31T08:01:00.000Z",
    })),
  };
}

const listeners: Array<(event: Event) => void> = [];

function listenForTreeChanges() {
  const listener = vi.fn<[Event], void>();
  window.addEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, listener);
  listeners.push(listener);
  return listener;
}

afterEach(() => {
  for (const listener of listeners.splice(0)) {
    window.removeEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, listener);
  }
});

describe("knowledgeTreeTitleSyncBridge", () => {
  it("notifies the knowledge tree after a server-confirmed title change", async () => {
    const target = createApi();
    const listener = listenForTreeChanges();
    installKnowledgeTreeTitleSyncBridge(target as unknown as KnowledgeTreeTitleSyncApi);

    await target.getNote("note-1");
    await target.updateNote("note-1", { title: "新标题" });

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({
      reason: "note-title-updated",
      resourceId: "note-1",
      title: "新标题",
      updatedAt: "2026-07-31T08:01:00.000Z",
    });
  });

  it("does not reload the tree for content-only autosaves", async () => {
    const target = createApi();
    const listener = listenForTreeChanges();
    installKnowledgeTreeTitleSyncBridge(target as unknown as KnowledgeTreeTitleSyncApi);

    await target.getNote("note-1");
    await target.updateNote("note-1", {
      title: "旧标题",
      contentText: "更新后的正文",
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("establishes an unknown title baseline without a redundant tree reload", async () => {
    const target = createApi();
    const listener = listenForTreeChanges();
    installKnowledgeTreeTitleSyncBridge(target as unknown as KnowledgeTreeTitleSyncApi);

    await target.updateNote("note-1", {
      title: "旧标题",
      contentText: "首次自动保存",
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not notify before a failed save is confirmed", async () => {
    const target = createApi();
    target.updateNote.mockRejectedValueOnce(new Error("save failed"));
    const listener = listenForTreeChanges();
    installKnowledgeTreeTitleSyncBridge(target as unknown as KnowledgeTreeTitleSyncApi);

    await target.getNote("note-1");
    await expect(target.updateNote("note-1", { title: "不会生效" })).rejects.toThrow("save failed");

    expect(listener).not.toHaveBeenCalled();
  });

  it("installs only once for the same api object", async () => {
    const target = createApi();
    const listener = listenForTreeChanges();
    installKnowledgeTreeTitleSyncBridge(target as unknown as KnowledgeTreeTitleSyncApi);
    installKnowledgeTreeTitleSyncBridge(target as unknown as KnowledgeTreeTitleSyncApi);

    await target.getNote("note-1");
    await target.updateNote("note-1", { title: "新标题" });

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
