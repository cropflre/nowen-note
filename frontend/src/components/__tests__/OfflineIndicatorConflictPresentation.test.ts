import { describe, expect, it } from "vitest";
import type { OfflineQueueItem } from "@/lib/offlineQueue";
import {
  getQueueItemNotePreview,
  getQueueItemNoteTitle,
  getQueueItemStatusMessage,
  getSyncIndicatorPresentation,
} from "../common/OfflineIndicator";

function conflictItem(overrides: Partial<OfflineQueueItem> = {}): OfflineQueueItem {
  return {
    id: "queue-1",
    type: "updateNote",
    noteId: "1a87b7d9-2d9d-40f4-b7e2-871ec488807e",
    url: "/notes/1a87b7d9-2d9d-40f4-b7e2-871ec488807e",
    method: "PUT",
    body: {
      title: "产品需求记录",
      content: "# 产品需求记录\n\n同步冲突处理方案",
      contentText: "同步冲突处理方案",
      version: 3,
    },
    localPayload: {
      title: "产品需求记录",
      content: "# 产品需求记录\n\n同步冲突处理方案",
      contentText: "同步冲突处理方案",
      version: 3,
    },
    enqueuedAt: Date.now(),
    retryCount: 0,
    conflict: true,
    blocked: true,
    errorCode: "VERSION_CONFLICT",
    message: "Version conflict detected. Auto overwrite was stopped. Please refresh or resolve from version history.",
    ...overrides,
  };
}

const basePresentationInput = {
  isOnline: true,
  isBootstrapping: false,
  showSyncing: false,
  pendingCount: 0,
  showPending: false,
  failedCount: 0,
  conflictCount: 0,
  queueCount: 0,
  lastError: null,
};

describe("OfflineIndicator conflict presentation", () => {
  it("shows the note title from the preserved local payload", () => {
    expect(getQueueItemNoteTitle(conflictItem())).toBe("产品需求记录");
  });

  it("shows a readable content preview instead of the note id", () => {
    expect(getQueueItemNotePreview(conflictItem())).toBe("同步冲突处理方案");
  });

  it("replaces persisted English conflict errors with a clear user-facing explanation", () => {
    expect(getQueueItemStatusMessage(conflictItem())).toBe("两个版本均已保留，请确认最终使用的内容。");
  });

  it("falls back safely when old queue data has no title or content", () => {
    const item = conflictItem({ body: null, localPayload: null });
    expect(getQueueItemNoteTitle(item)).toBe("未命名笔记");
    expect(getQueueItemNotePreview(item)).toBe("");
  });
});

describe("OfflineIndicator status information architecture", () => {
  it("keeps normal successful synchronization invisible", () => {
    expect(getSyncIndicatorPresentation(basePresentationInput)).toBeNull();
  });

  it("does not show a short bootstrap operation before the delay", () => {
    expect(getSyncIndicatorPresentation({
      ...basePresentationInput,
      isBootstrapping: true,
      showSyncing: false,
    })).toBeNull();
  });

  it("shows long-running synchronization as a compact non-expandable status", () => {
    expect(getSyncIndicatorPresentation({
      ...basePresentationInput,
      isBootstrapping: true,
      showSyncing: true,
    })).toMatchObject({
      tone: "syncing",
      label: "正在同步…",
      action: "none",
      compact: true,
    });
  });

  it("explains offline preservation without exposing the queue", () => {
    expect(getSyncIndicatorPresentation({
      ...basePresentationInput,
      isOnline: false,
      pendingCount: 2,
      queueCount: 2,
    })).toMatchObject({
      tone: "offline",
      label: "当前离线",
      description: "2 项修改已保存在本机，联网后将自动同步。",
      action: "none",
    });
  });

  it("does not flash transient pending writes before they become meaningful", () => {
    expect(getSyncIndicatorPresentation({
      ...basePresentationInput,
      pendingCount: 1,
      queueCount: 1,
      showPending: false,
    })).toBeNull();
  });

  it("offers details only when actual unsynchronized content exists", () => {
    expect(getSyncIndicatorPresentation({
      ...basePresentationInput,
      pendingCount: 2,
      queueCount: 2,
      showPending: true,
    })).toMatchObject({
      tone: "pending",
      label: "2 项修改尚未同步",
      action: "details",
      actionLabel: "查看并重试",
    });
  });

  it("uses an explicit conflict message instead of a generic queue state", () => {
    expect(getSyncIndicatorPresentation({
      ...basePresentationInput,
      pendingCount: 3,
      failedCount: 3,
      conflictCount: 3,
      queueCount: 3,
    })).toMatchObject({
      tone: "error",
      label: "3 篇笔记存在版本冲突",
      description: "两个版本均已保留，请查看后确认最终内容。",
      action: "details",
      actionLabel: "查看冲突",
    });
  });

  it("offers a direct retry when synchronization failed without queue items", () => {
    expect(getSyncIndicatorPresentation({
      ...basePresentationInput,
      lastError: "network timeout",
    })).toMatchObject({
      tone: "error",
      label: "同步暂时失败",
      action: "retry",
      actionLabel: "重新同步",
    });
  });
});
