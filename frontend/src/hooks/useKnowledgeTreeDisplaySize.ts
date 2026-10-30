import { useCallback, useSyncExternalStore } from "react";

export type KnowledgeTreeDisplaySize = "default" | "large" | "extra-large";
export const KNOWLEDGE_TREE_DISPLAY_SIZE_STORAGE_KEY = "nowen.knowledgeTree.displaySize.v1";
const CHANGED_EVENT = "nowen:knowledge-tree-display-size-changed";
let memorySize: KnowledgeTreeDisplaySize = "default";
let storageUnavailable = false;

function normalizeSize(value: unknown): KnowledgeTreeDisplaySize {
  return value === "large" || value === "extra-large" ? value : "default";
}

export function readKnowledgeTreeDisplaySize(): KnowledgeTreeDisplaySize {
  if (storageUnavailable) return memorySize;
  try {
    return normalizeSize(localStorage.getItem(KNOWLEDGE_TREE_DISPLAY_SIZE_STORAGE_KEY));
  } catch {
    return memorySize;
  }
}

export function saveKnowledgeTreeDisplaySize(size: KnowledgeTreeDisplaySize): void {
  memorySize = normalizeSize(size);
  try {
    localStorage.setItem(KNOWLEDGE_TREE_DISPLAY_SIZE_STORAGE_KEY, memorySize);
    storageUnavailable = false;
  } catch {
    storageUnavailable = true;
    // 禁用存储时仍允许当前窗口调整显示大小。
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KNOWLEDGE_TREE_DISPLAY_SIZE_STORAGE_KEY || event.key === null) {
      memorySize = normalizeSize(event.newValue);
      onChange();
    }
  };
  window.addEventListener(CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useKnowledgeTreeDisplaySize(): readonly [KnowledgeTreeDisplaySize, (size: KnowledgeTreeDisplaySize) => void] {
  const size = useSyncExternalStore(subscribe, readKnowledgeTreeDisplaySize, (): KnowledgeTreeDisplaySize => "default");
  const setSize = useCallback((next: KnowledgeTreeDisplaySize) => saveKnowledgeTreeDisplaySize(next), []);
  return [size, setSize] as const;
}
