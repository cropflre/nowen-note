import { describe, expect, it } from "vitest";

import {
  SIDEBAR_TREE_MODE_STORAGE_KEY,
  loadSidebarTreeMode,
  nextSidebarTreeMode,
  parseSidebarTreeMode,
  saveSidebarTreeMode,
  type SidebarTreeModeStorage,
} from "@/lib/sidebarTreeMode";

function createStorage(initial?: string): SidebarTreeModeStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key) {
      return key === SIDEBAR_TREE_MODE_STORAGE_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (key === SIDEBAR_TREE_MODE_STORAGE_KEY) this.value = value;
    },
  };
}

describe("sidebarTreeMode", () => {
  it("defaults to the unified knowledge tree", () => {
    expect(parseSidebarTreeMode(undefined)).toBe("knowledge");
    expect(parseSidebarTreeMode("unknown")).toBe("knowledge");
    expect(loadSidebarTreeMode(createStorage())).toBe("knowledge");
  });

  it("restores the explicit legacy compatibility mode", () => {
    expect(parseSidebarTreeMode("legacy")).toBe("legacy");
    expect(loadSidebarTreeMode(createStorage("legacy"))).toBe("legacy");
  });

  it("persists mode switches without changing data", () => {
    const storage = createStorage();
    expect(saveSidebarTreeMode("legacy", storage)).toBe("legacy");
    expect(storage.value).toBe("legacy");
    expect(loadSidebarTreeMode(storage)).toBe("legacy");
    expect(nextSidebarTreeMode("legacy")).toBe("knowledge");
    expect(nextSidebarTreeMode("knowledge")).toBe("legacy");
  });

  it("falls back safely when storage throws", () => {
    const storage: SidebarTreeModeStorage = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
    };
    expect(loadSidebarTreeMode(storage)).toBe("knowledge");
    expect(() => saveSidebarTreeMode("legacy", storage)).not.toThrow();
  });
});
