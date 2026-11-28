// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MindMap, MindMapData } from "@/types";

const MAP_A_ID = "11111111-1111-4111-8111-111111111111";
const MAP_B_ID = "22222222-2222-4222-8222-222222222222";

const { getMindMap, getMindMaps, updateMindMap, listTree } = vi.hoisted(() => ({
  getMindMap: vi.fn(),
  getMindMaps: vi.fn(),
  updateMindMap: vi.fn(),
  listTree: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { getMindMap, getMindMaps, updateMindMap },
  getCurrentWorkspace: () => null,
}));
vi.mock("@/lib/knowledgeTreeApi", () => ({
  knowledgeTreeApi: { list: listTree, create: vi.fn() },
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
}));

import MindMapCenter from "@/components/MindMapEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  disconnect() {}
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeMap(id: string, title: string, rootText: string, updatedAt = "2026-11-27 10:00:00.000"): MindMap {
  const data: MindMapData = {
    root: {
      id: "root",
      text: rootText,
      children: [{ id: `${id}-child-1`, text: `${rootText}-子项`, children: [] }],
    },
  };
  return {
    id,
    userId: "user-1",
    workspaceId: null,
    title,
    data: JSON.stringify(data),
    createdAt: "2026-11-27 09:00:00.000",
    updatedAt,
    canEdit: true,
  };
}

async function flushMicrotasks(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

describe("MindMapEditor cross-map save isolation (issue #938)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let store: Map<string, MindMap>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    store = new Map([
      [MAP_A_ID, makeMap(MAP_A_ID, "导图A", "主题A", "2026-11-27 10:00:00.000")],
      [MAP_B_ID, makeMap(MAP_B_ID, "导图B", "主题B", "2026-11-27 10:00:00.000")],
    ]);
    getMindMaps.mockImplementation(async () => Array.from(store.values()));
    listTree.mockResolvedValue({ nodes: [] });
    getMindMap.mockImplementation(async (id: string) => {
      const found = store.get(id);
      if (!found) throw new Error(`Map not found: ${id}`);
      return { ...found };
    });
    updateMindMap.mockImplementation(async (id: string, payload: { data?: string; title?: string }) => {
      const prev = store.get(id);
      if (!prev) throw new Error(`Map not found: ${id}`);
      const next: MindMap = {
        ...prev,
        title: payload.title ?? prev.title,
        data: payload.data ?? prev.data,
        updatedAt: `2026-11-27 10:00:0${updateMindMap.mock.calls.length}.123`,
      };
      store.set(id, next);
      return { ...next };
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  async function selectRootAndAddChild() {
    const rootNode = host.querySelector<HTMLElement>('[data-mindmap-node-id="root"]');
    expect(rootNode).not.toBeNull();
    await act(async () => {
      rootNode!.click();
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>("input");
    if (input) {
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
    }
  }

  it("never overwrites Map A with Map B content when Map A's save resolves after switching to Map B", async () => {
    const saveADeferred = createDeferred<MindMap>();
    updateMindMap.mockImplementation((id: string, payload: { data?: string; title?: string }) => {
      if (id === MAP_A_ID && updateMindMap.mock.calls.length === 1) {
        return saveADeferred.promise.then((res) => {
          store.set(id, res);
          return res;
        });
      }
      const prev = store.get(id)!;
      const next: MindMap = {
        ...prev,
        title: payload.title ?? prev.title,
        data: payload.data ?? prev.data,
        updatedAt: `2026-11-27 10:01:0${updateMindMap.mock.calls.length}.000`,
      };
      store.set(id, next);
      return Promise.resolve({ ...next });
    });

    // 1. 打开导图 A 并新增一个节点（触发保存）
    await act(async () => {
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_A_ID} />);
      await flushMicrotasks();
    });
    expect(host.querySelector("h1")?.textContent).toBe("导图A");

    await selectRootAndAddChild();
    await act(async () => {
      vi.advanceTimersByTime(650);
      await flushMicrotasks();
    });
    expect(updateMindMap).toHaveBeenCalledTimes(1);
    expect(updateMindMap).toHaveBeenLastCalledWith(MAP_A_ID, expect.any(Object));
    const savedAPayload = updateMindMap.mock.calls[0][1] as { data: string };

    // 2. 在导图 A 的 PUT 尚未返回时，切换到同一目录下的导图 B
    await act(async () => {
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_B_ID} />);
      await flushMicrotasks();
    });
    expect(host.querySelector("h1")?.textContent).toBe("导图B");

    // 3. 此时导图 A 的异步保存响应晚到返回
    await act(async () => {
      saveADeferred.resolve({
        ...store.get(MAP_A_ID)!,
        data: savedAPayload.data,
        updatedAt: "2026-11-27 10:00:59.000",
      });
      await flushMicrotasks();
    });

    // 4. 用户继续编辑导图 B
    await selectRootAndAddChild();
    await act(async () => {
      vi.advanceTimersByTime(650);
      await flushMicrotasks();
    });

    // 断言：第二次保存必须写回导图 B，绝不能写到导图 A
    expect(updateMindMap).toHaveBeenCalledTimes(2);
    expect(updateMindMap.mock.calls[1][0]).toBe(MAP_B_ID);
    expect(JSON.parse(store.get(MAP_A_ID)!.data).root.text).toBe("主题A");
    expect(JSON.parse(store.get(MAP_B_ID)!.data).root.text).toBe("主题B");
  });

  it("flushes Map A's debounced save before switching to Map B so neither map loses edits or cross-writes", async () => {
    await act(async () => {
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_A_ID} />);
      await flushMicrotasks();
    });

    // 编辑导图 A，但不等 600ms 防抖结束就立刻切换到导图 B
    await selectRootAndAddChild();
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(updateMindMap).not.toHaveBeenCalled();

    await act(async () => {
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_B_ID} />);
      await flushMicrotasks();
    });

    // 切换时应立即冲刷导图 A 的保存，且目标 ID 必须是 MAP_A_ID
    expect(updateMindMap).toHaveBeenCalledTimes(1);
    expect(updateMindMap.mock.calls[0][0]).toBe(MAP_A_ID);
    const savedAData = JSON.parse((updateMindMap.mock.calls[0][1] as { data: string }).data) as MindMapData;
    expect(savedAData.root.text).toBe("主题A");
    expect(savedAData.root.children).toHaveLength(2);

    // 紧接着在导图 B 编辑
    await selectRootAndAddChild();
    await act(async () => {
      vi.advanceTimersByTime(650);
      await flushMicrotasks();
    });

    expect(updateMindMap).toHaveBeenCalledTimes(2);
    expect(updateMindMap.mock.calls[1][0]).toBe(MAP_B_ID);
    const savedBData = JSON.parse((updateMindMap.mock.calls[1][1] as { data: string }).data) as MindMapData;
    expect(savedBData.root.text).toBe("主题B");
    expect(savedBData.root.children).toHaveLength(2);
  });

  it("cancels Map A's pending viewport save timer when switching to Map B", async () => {
    await act(async () => {
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_A_ID} />);
      await flushMicrotasks();
    });

    // 在导图 A 点击放大按钮（触发 700ms viewportSaveTimer）
    const zoomInBtn = host.querySelector<HTMLButtonElement>('button[title="mindMap.zoomIn"]');
    expect(zoomInBtn).not.toBeNull();
    await act(async () => {
      zoomInBtn!.click();
    });

    // 200ms 后切换到导图 B
    await act(async () => {
      vi.advanceTimersByTime(200);
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_B_ID} />);
      await flushMicrotasks();
    });
    expect(host.querySelector("h1")?.textContent).toBe("导图B");

    // 推进超过 700ms + 600ms，确认不会把导图 A 的 viewport 保存到导图 B
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await flushMicrotasks();
    });

    const bWrites = updateMindMap.mock.calls.filter(([id]) => id === MAP_B_ID);
    expect(bWrites).toHaveLength(0);
    expect(JSON.parse(store.get(MAP_B_ID)!.data).viewport).toBeUndefined();
  });

  it("waits for Map A's in-flight flushed save before reloading Map A on rapid A -> B -> A switch", async () => {
    const saveADeferred = createDeferred<MindMap>();
    updateMindMap.mockImplementation((id: string, payload: { data?: string; title?: string }) => {
      if (id === MAP_A_ID) {
        return saveADeferred.promise.then((res) => {
          store.set(id, res);
          return res;
        });
      }
      const prev = store.get(id)!;
      const next = { ...prev, data: payload.data ?? prev.data, title: payload.title ?? prev.title };
      store.set(id, next);
      return Promise.resolve({ ...next });
    });

    await act(async () => {
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_A_ID} />);
      await flushMicrotasks();
    });
    await selectRootAndAddChild();

    // A -> B（立即触发 A 的 flush PUT，但 PUT 仍在路上）
    await act(async () => {
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_B_ID} />);
      await flushMicrotasks();
    });
    expect(updateMindMap).toHaveBeenCalledTimes(1);
    const savedADataStr = (updateMindMap.mock.calls[0][1] as { data: string }).data;

    // 立即切回 A，此时 GET A 应等待 PUT A 完成
    const getCallsBeforeReturn = getMindMap.mock.calls.filter(([id]) => id === MAP_A_ID).length;
    await act(async () => {
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_A_ID} />);
      await flushMicrotasks();
    });
    expect(getMindMap.mock.calls.filter(([id]) => id === MAP_A_ID).length).toBe(getCallsBeforeReturn);

    // PUT A 完成后，GET A 才发出并拿到最新内容
    await act(async () => {
      saveADeferred.resolve({
        ...store.get(MAP_A_ID)!,
        data: savedADataStr,
        updatedAt: "2026-11-27 10:02:00.000",
      });
      await flushMicrotasks();
    });

    expect(getMindMap.mock.calls.filter(([id]) => id === MAP_A_ID).length).toBe(getCallsBeforeReturn + 1);
    expect(host.querySelectorAll('[data-mindmap-node-id]').length).toBe(3);
  });

  it("resets undo history even when loading a map with invalid JSON fallback so Ctrl+Z never restores the previous map", async () => {
    store.set(MAP_B_ID, {
      ...store.get(MAP_B_ID)!,
      data: "{invalid-json",
    });

    await act(async () => {
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_A_ID} />);
      await flushMicrotasks();
    });
    await selectRootAndAddChild();
    await act(async () => {
      vi.advanceTimersByTime(650);
      await flushMicrotasks();
    });

    // 切到数据损坏的导图 B
    await act(async () => {
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_B_ID} />);
      await flushMicrotasks();
    });
    expect(host.querySelector("h1")?.textContent).toBe("导图B");

    // 按 Ctrl+Z，不应撤销回导图 A 的历史并覆盖导图 B
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
      vi.advanceTimersByTime(1000);
      await flushMicrotasks();
    });

    const bWrites = updateMindMap.mock.calls.filter(([id]) => id === MAP_B_ID);
    expect(bWrites).toHaveLength(0);
    expect(host.textContent).not.toContain("主题A");
  });

  it("isolates embeddedMode saves by mapId when embeddedMindMapId changes", async () => {
    const saveADeferred = createDeferred<MindMap>();
    updateMindMap.mockImplementation((id: string, payload: { data?: string; title?: string; expectedUpdatedAt?: string }) => {
      if (id === MAP_A_ID) {
        return saveADeferred.promise.then((res) => {
          store.set(id, res);
          return res;
        });
      }
      const prev = store.get(id)!;
      const next: MindMap = {
        ...prev,
        title: payload.title ?? prev.title,
        data: payload.data ?? prev.data,
        updatedAt: "2026-11-27 10:05:00.000",
      };
      store.set(id, next);
      return Promise.resolve({ ...next });
    });

    await act(async () => {
      root.render(<MindMapCenter embeddedMode embeddedMindMapId={MAP_A_ID} />);
      await flushMicrotasks();
    });
    await selectRootAndAddChild();
    await act(async () => {
      vi.advanceTimersByTime(650);
      await flushMicrotasks();
    });
    expect(updateMindMap).toHaveBeenCalledTimes(1);
    expect(updateMindMap.mock.calls[0][0]).toBe(MAP_A_ID);
    expect((updateMindMap.mock.calls[0][1] as { expectedUpdatedAt?: string }).expectedUpdatedAt).toBe(
      "2026-11-27 10:00:00.000",
    );

    // 切换到导图 B，再让导图 A 的保存完成
    await act(async () => {
      root.render(<MindMapCenter embeddedMode embeddedMindMapId={MAP_B_ID} />);
      await flushMicrotasks();
    });
    await act(async () => {
      saveADeferred.resolve({
        ...store.get(MAP_A_ID)!,
        data: (updateMindMap.mock.calls[0][1] as { data: string }).data,
        updatedAt: "2026-11-27 10:04:00.000",
      });
      await flushMicrotasks();
    });

    // 在导图 B 编辑，必须写回 MAP_B_ID 并携带 MAP_B_ID 自己的 expectedUpdatedAt
    await selectRootAndAddChild();
    await act(async () => {
      vi.advanceTimersByTime(650);
      await flushMicrotasks();
    });

    expect(updateMindMap).toHaveBeenCalledTimes(2);
    expect(updateMindMap.mock.calls[1][0]).toBe(MAP_B_ID);
    expect((updateMindMap.mock.calls[1][1] as { expectedUpdatedAt?: string }).expectedUpdatedAt).toBe(
      "2026-11-27 10:00:00.000",
    );
    expect(JSON.parse(store.get(MAP_A_ID)!.data).root.text).toBe("主题A");
    expect(JSON.parse(store.get(MAP_B_ID)!.data).root.text).toBe("主题B");
  });
});
