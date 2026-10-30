import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KNOWLEDGE_TREE_DISPLAY_SIZE_STORAGE_KEY,
  readKnowledgeTreeDisplaySize,
  saveKnowledgeTreeDisplaySize,
  useKnowledgeTreeDisplaySize,
} from "../useKnowledgeTreeDisplaySize";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  saveKnowledgeTreeDisplaySize("default");
  localStorage.removeItem(KNOWLEDGE_TREE_DISPLAY_SIZE_STORAGE_KEY);
  document.body.innerHTML = "";
});

describe("知识树显示大小", () => {
  it("旧设备和无效配置都沿用默认大小", () => {
    expect(readKnowledgeTreeDisplaySize()).toBe("default");
    localStorage.setItem(KNOWLEDGE_TREE_DISPLAY_SIZE_STORAGE_KEY, "unexpected");
    expect(readKnowledgeTreeDisplaySize()).toBe("default");
  });

  it("立即更新所有消费者，持久化选择并响应其他标签页恢复默认", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    function Consumer() {
      const [size, setSize] = useKnowledgeTreeDisplaySize();
      return <button onClick={() => setSize("large")}>{size}</button>;
    }
    act(() => root?.render(<><Consumer /><Consumer /></>));
    act(() => host.querySelector("button")?.click());
    expect(host.textContent).toBe("largelarge");
    expect(localStorage.getItem(KNOWLEDGE_TREE_DISPLAY_SIZE_STORAGE_KEY)).toBe("large");
    localStorage.removeItem(KNOWLEDGE_TREE_DISPLAY_SIZE_STORAGE_KEY);
    act(() => window.dispatchEvent(new StorageEvent("storage", {
      key: KNOWLEDGE_TREE_DISPLAY_SIZE_STORAGE_KEY, newValue: null,
    })));
    expect(host.textContent).toBe("defaultdefault");
  });

  it("存储已满但仍可读取时，新选择仍立即生效", () => {
    localStorage.setItem(KNOWLEDGE_TREE_DISPLAY_SIZE_STORAGE_KEY, "default");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("存储已满"); });
    saveKnowledgeTreeDisplaySize("large");
    expect(readKnowledgeTreeDisplaySize()).toBe("large");
  });

  it("浏览器禁止存储时仍可使用并恢复显示大小", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("禁用存储"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("禁用存储"); });
    saveKnowledgeTreeDisplaySize("extra-large");
    expect(readKnowledgeTreeDisplaySize()).toBe("extra-large");
    saveKnowledgeTreeDisplaySize("default");
    expect(readKnowledgeTreeDisplaySize()).toBe("default");
  });
});
