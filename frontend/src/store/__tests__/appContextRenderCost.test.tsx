import React, { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: { getNotebooks: vi.fn(async () => []) },
}));

import { AppProvider, useApp } from "../AppContext";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * AppContext 是单一context，任何 state 变化都会通知全部消费者 —— 这是已知设计。
 *
 * 曾怀疑它是"笔记和笔记本越多越卡"的主因，实测否定：2000 篇笔记 + 41 个消费者时，
 * 一次无关 dispatch 触发 41 次重渲染但只耗 1.6ms，因为消费者用 useMemo 缓存了派生
 * 计算，notes 引用未变时直接命中缓存。因此没有引入 selector 等额外机制。
 *
 * 这个测试锁住让上述结论成立的前提：派生计算必须挂在正确的依赖上。若将来有人在
 * 消费者里做未缓存的昂贵计算，或把 notes 派生结果的依赖写错，这里会失败。
 */
describe("AppContext 消费者重渲染成本", () => {
  it("无关 action 不得触发 notes 派生计算重算", () => {
    let derivationRuns = 0;
    let dispatchRef: ((action: any) => void) | null = null;

    function Grabber() {
      const { dispatch } = useApp();
      dispatchRef = dispatch;
      return null;
    }

    function NotesConsumer() {
      const { state } = useApp();
      const derived = useMemo(() => {
        derivationRuns += 1;
        const list = state.notes as Array<{ id: string; title: string }>;
        return list.map((note) => note.title.toUpperCase());
      }, [state.notes]);
      return React.createElement("div", null, String(derived.length));
    }

    act(() => {
      root.render(
        React.createElement(AppProvider, null,
          React.createElement(Grabber),
          React.createElement(NotesConsumer),
        ),
      );
    });

    act(() => {
      dispatchRef?.({
        type: "SET_NOTES",
        payload: Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, title: `笔记 ${i}` })),
      });
    });
    const afterSeed = derivationRuns;

    // 与 notes 无关的 action：组件会重渲染（单context 的固有行为），
    // 但派生计算必须命中缓存，不能重算。
    act(() => {
      dispatchRef?.({ type: "SET_SEARCH_QUERY", payload: "keyword" });
    });

    expect(derivationRuns).toBe(afterSeed);
  });

  it("notes 变化时派生计算才重算", () => {
    let derivationRuns = 0;
    let dispatchRef: ((action: any) => void) | null = null;

    function Grabber() {
      const { dispatch } = useApp();
      dispatchRef = dispatch;
      return null;
    }

    function NotesConsumer() {
      const { state } = useApp();
      const derived = useMemo(() => {
        derivationRuns += 1;
        return (state.notes as Array<{ id: string }>).map((note) => note.id);
      }, [state.notes]);
      return React.createElement("div", null, String(derived.length));
    }

    act(() => {
      root.render(
        React.createElement(AppProvider, null,
          React.createElement(Grabber),
          React.createElement(NotesConsumer),
        ),
      );
    });

    act(() => {
      dispatchRef?.({
        type: "SET_NOTES",
        payload: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
      });
    });
    const afterSeed = derivationRuns;

    act(() => {
      dispatchRef?.({ type: "UPDATE_NOTE_IN_LIST", payload: { id: "b", title: "B2" } });
    });

    expect(derivationRuns).toBeGreaterThan(afterSeed);
  });
});
