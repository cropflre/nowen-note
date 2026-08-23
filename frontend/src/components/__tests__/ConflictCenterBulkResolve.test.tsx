import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictCenter } from "../settings/ConflictCenter";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const {
  fetchConflictDetailMock,
  fetchConflictsMock,
  fetchResolvedConflictsMock,
  forkConflictMock,
  reopenConflictMock,
  resolveConflictMock,
} = vi.hoisted(() => ({
  fetchConflictDetailMock: vi.fn(),
  fetchConflictsMock: vi.fn(),
  fetchResolvedConflictsMock: vi.fn(),
  forkConflictMock: vi.fn(),
  reopenConflictMock: vi.fn(),
  resolveConflictMock: vi.fn(),
}));

vi.mock("@/lib/syncLocalApi", () => ({
  SYNC_CONFLICT_ENTITY_TYPES: [
    "notebook",
    "note",
    "tag",
    "note_tag",
    "favorite",
    "attachment",
    "task",
    "task_reminder",
    "diary",
    "mindmap",
  ],
  fetchConflictDetail: fetchConflictDetailMock,
  fetchConflicts: fetchConflictsMock,
  fetchResolvedConflicts: fetchResolvedConflictsMock,
  forkConflict: forkConflictMock,
  reopenConflict: reopenConflictMock,
  resolveConflict: resolveConflictMock,
}));

const conflicts = [
  {
    id: "conflict-1",
    entityType: "note",
    entityId: "note-1",
    localVersion: 2,
    remoteVersion: 3,
    createdAt: "2026-08-23T01:00:00.000Z",
    diffFields: ["content"],
    localTitle: "项目计划",
    remoteTitle: "项目计划（服务器）",
  },
  {
    id: "conflict-2",
    entityType: "task",
    entityId: "task-1",
    localVersion: null,
    remoteVersion: null,
    createdAt: "2026-08-23T02:00:00.000Z",
    diffFields: ["title"],
    localTitle: "本机任务",
    remoteTitle: "服务器任务",
  },
];

async function waitFor(assertion: () => void) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 1000) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("冲突中心批量处理", () => {
  let root: Root | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    fetchConflictsMock.mockReset();
    fetchResolvedConflictsMock.mockReset();
    fetchResolvedConflictsMock.mockResolvedValue({ total: 0, items: [] });
    fetchConflictDetailMock.mockReset();
    forkConflictMock.mockReset();
    reopenConflictMock.mockReset();
    reopenConflictMock.mockResolvedValue({
      conflictId: "resolved",
      reopened: true,
      alreadyOpen: false,
      remainingConflicts: 1,
      message: "已重新放回冲突中心，请重新选择要采用的版本。",
    });
    resolveConflictMock.mockReset();
    resolveConflictMock.mockResolvedValue({
      conflictId: "resolved",
      resolution: "keep-local",
      remainingConflicts: 0,
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("全选后批量采用本机版本", async () => {
    fetchConflictsMock
      .mockResolvedValueOnce({ total: conflicts.length, items: conflicts })
      .mockResolvedValueOnce({ total: 0, items: [] });
    const onResolved = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<ConflictCenter deviceId="device-1" onResolved={onResolved} />);
    });
    await waitFor(() => expect(host.textContent).toContain("冲突（2）"));

    const selectAll = host.querySelector<HTMLInputElement>('input[aria-label="全选冲突"]');
    await act(async () => selectAll?.click());
    expect(host.textContent).toContain("已选 2 项");

    const bulkLocal = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "一键采用本机");
    await act(async () => bulkLocal?.click());

    await waitFor(() => {
      expect(resolveConflictMock).toHaveBeenCalledTimes(2);
      expect(onResolved).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("没有需要处理的冲突");
    });
    expect(resolveConflictMock).toHaveBeenNthCalledWith(1, "conflict-1", {
      resolution: "keep-local",
      deviceId: "device-1",
    });
    expect(resolveConflictMock).toHaveBeenNthCalledWith(2, "conflict-2", {
      resolution: "keep-local",
      deviceId: "device-1",
    });
  });

  it("只处理勾选项并采用服务器版本", async () => {
    fetchConflictsMock
      .mockResolvedValueOnce({ total: conflicts.length, items: conflicts })
      .mockResolvedValueOnce({ total: 1, items: [conflicts[1]] });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<ConflictCenter deviceId="device-2" />);
    });
    await waitFor(() => expect(host.textContent).toContain("冲突（2）"));

    const first = host.querySelector<HTMLInputElement>('input[aria-label="选择冲突 项目计划"]');
    await act(async () => first?.click());
    const bulkRemote = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "一键采用服务器");
    await act(async () => bulkRemote?.click());

    await waitFor(() => expect(resolveConflictMock).toHaveBeenCalledTimes(1));
    expect(resolveConflictMock).toHaveBeenCalledWith("conflict-1", {
      resolution: "keep-remote",
      deviceId: "device-2",
    });
    expect(host.textContent).toContain("本机任务");
    expect(host.textContent).not.toContain("项目计划（服务器）");
  });

  it("智能合并不重叠字段并保留同字段冲突", async () => {
    fetchConflictsMock
      .mockResolvedValueOnce({ total: conflicts.length, items: conflicts })
      .mockResolvedValueOnce({ total: 1, items: [conflicts[1]] });
    fetchConflictDetailMock.mockImplementation(async (id: string) => {
      if (id === "conflict-1") {
        return {
          ...conflicts[0],
          status: "unresolved",
          resolvedAt: null,
          base: { id: "note-1", title: "旧标题", content: "旧正文" },
          local: { id: "note-1", title: "项目计划", content: "旧正文" },
          remote: { id: "note-1", title: "旧标题", content: "服务器正文" },
        };
      }
      return {
        ...conflicts[1],
        status: "unresolved",
        resolvedAt: null,
        base: { id: "task-1", title: "旧任务" },
        local: { id: "task-1", title: "本机任务" },
        remote: { id: "task-1", title: "服务器任务" },
      };
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<ConflictCenter deviceId="device-3" />);
    });
    await waitFor(() => expect(host.textContent).toContain("冲突（2）"));

    const selectAll = host.querySelector<HTMLInputElement>('input[aria-label="全选冲突"]');
    await act(async () => selectAll?.click());
    const smartMerge = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("智能合并选中项"));
    await act(async () => smartMerge?.click());

    await waitFor(() => {
      expect(resolveConflictMock).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("已智能合并 1 条，1 条仍需手动处理");
    });
    expect(resolveConflictMock).toHaveBeenCalledWith("conflict-1", {
      resolution: "manual",
      mergedPayload: {
        content: "服务器正文",
        id: "note-1",
        title: "项目计划",
      },
      deviceId: "device-3",
    });
    expect(host.textContent).toContain("重叠字段：title");
    expect(host.textContent).toContain("本机任务");
  });

  it("查看已解决历史并撤销处理后重新选择", async () => {
    const historyItem = {
      ...conflicts[0],
      resolvedAt: "2026-08-23T04:00:00.000Z",
    };
    fetchConflictsMock
      .mockResolvedValueOnce({ total: 0, items: [] })
      .mockResolvedValueOnce({ total: 1, items: [conflicts[0]] });
    fetchResolvedConflictsMock.mockReset();
    fetchResolvedConflictsMock
      .mockResolvedValueOnce({ total: 1, items: [historyItem] })
      .mockResolvedValueOnce({ total: 0, items: [] });
    fetchConflictDetailMock.mockResolvedValue({
      ...historyItem,
      status: "resolved",
      base: { id: "note-1", title: "旧标题" },
      local: { id: "note-1", title: "项目计划" },
      remote: { id: "note-1", title: "项目计划（服务器）" },
    });
    const onResolved = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<ConflictCenter deviceId="device-4" onResolved={onResolved} />);
    });
    await waitFor(() => expect(host.textContent).toContain("已解决冲突（1）"));

    const historyToggle = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("已解决冲突（1）"));
    await act(async () => historyToggle?.click());
    expect(host.textContent).toContain("不会自动回滚当前内容");

    const view = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "查看记录");
    await act(async () => view?.click());
    await waitFor(() => {
      expect(host.textContent).toContain("这是已解决冲突的历史记录");
      expect(host.textContent).not.toContain("手动编辑并合并");
    });

    const reopen = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("撤销处理"));
    await act(async () => reopen?.click());
    await waitFor(() => {
      expect(reopenConflictMock).toHaveBeenCalledWith("conflict-1");
      expect(host.textContent).toContain("冲突（1）");
      expect(host.textContent).toContain("已重新放回冲突中心");
      expect(onResolved).toHaveBeenCalledTimes(1);
    });
  });

  it("分页加载已解决历史并按实体类型筛选", async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      ...conflicts[0],
      id: `history-${index + 1}`,
      entityId: `note-history-${index + 1}`,
      localTitle: `历史笔记 ${index + 1}`,
      resolvedAt: `2026-08-23T${String(20 - index).padStart(2, "0")}:00:00.000Z`,
    }));
    const lastItem = {
      ...conflicts[0],
      id: "history-21",
      entityId: "note-history-21",
      localTitle: "历史笔记 21",
      resolvedAt: "2026-08-22T23:00:00.000Z",
    };
    const taskItem = {
      ...conflicts[1],
      id: "history-task",
      localTitle: "本机任务历史",
      resolvedAt: "2026-08-23T21:00:00.000Z",
    };
    fetchConflictsMock.mockResolvedValue({ total: 0, items: [] });
    fetchResolvedConflictsMock.mockImplementation(async (options?: {
      offset?: number;
      entityType?: string;
    }) => {
      if (options?.entityType === "task") {
        return { total: 1, limit: 20, offset: 0, hasMore: false, items: [taskItem] };
      }
      if (options?.offset === 20) {
        return { total: 21, limit: 20, offset: 20, hasMore: false, items: [lastItem] };
      }
      return { total: 21, limit: 20, offset: 0, hasMore: true, items: firstPage };
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<ConflictCenter deviceId="device-5" />);
    });
    await waitFor(() => expect(host.textContent).toContain("已解决冲突（21）"));

    const historyToggle = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("已解决冲突（21）"));
    await act(async () => historyToggle?.click());
    const loadMore = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("加载更多"));
    await act(async () => loadMore?.click());
    await waitFor(() => expect(host.textContent).toContain("历史笔记 21"));
    expect(fetchResolvedConflictsMock).toHaveBeenCalledWith({
      limit: 20,
      offset: 20,
      entityType: undefined,
    });
    expect(host.textContent).not.toContain("加载更多（");

    const filter = host.querySelector<HTMLSelectElement>('select[aria-label="筛选已解决冲突类型"]');
    await act(async () => {
      if (!filter) return;
      filter.value = "task";
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => {
      expect(host.textContent).toContain("已解决冲突（1）");
      expect(host.textContent).toContain("本机任务历史");
      expect(host.textContent).not.toContain("历史笔记 1");
    });
    expect(fetchResolvedConflictsMock).toHaveBeenCalledWith({
      limit: 20,
      offset: 0,
      entityType: "task",
    });
  });
});
