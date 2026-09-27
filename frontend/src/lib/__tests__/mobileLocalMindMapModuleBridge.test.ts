// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { installMobileLocalModuleBridge } from "@/lib/mobileLocalModuleBridge";
import type { NativeDatabase } from "@/lib/nativeDatabase";
import type { NativeLocalRepository } from "@/lib/nativeLocalRepository";

afterEach(() => {
  localStorage.clear();
  delete (window as Window & { Capacitor?: unknown }).Capacitor;
});

describe("mobile local mind map module bridge", () => {
  it("hides trashed maps without removing their source rows", async () => {
    (window as Window & { Capacitor?: unknown }).Capacitor = { platform: "android" };
    localStorage.setItem("nowen-mobile-force-local-mode", "1");
    let map: {
      id: string; userId: string; workspaceId: null; title: string; data: string; starred: number;
      folderId: null; createdAt: string; updatedAt: string;
    } | null = {
      id: "map-1", userId: "android-local-user", workspaceId: null,
      title: "离线脑图", data: "{}", starred: 0, folderId: null,
      createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z",
    };
    let deleted = false;
    const db = {
      run: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO mobile_local_mindmap_tree")) deleted = true;
        if (sql.startsWith("DELETE FROM mindmaps")) map = null;
        if (sql.startsWith("DELETE FROM mobile_local_mindmap_tree")) deleted = false;
        return { changes: 1 };
      }),
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM mindmaps m LEFT JOIN mobile_local_mindmap_tree")) return deleted || !map ? [] : [map];
        if (sql.startsWith("SELECT isDeleted FROM mobile_local_mindmap_tree")) return [{ isDeleted: deleted ? 1 : 0 }];
        return [];
      }),
      transaction: vi.fn(async (work: (tx: NativeDatabase) => Promise<unknown>) => work(db as NativeDatabase)),
    } as unknown as NativeDatabase;
    const restore = installMobileLocalModuleBridge({} as NativeLocalRepository, db, "android-local-user");
    try {
      expect(await api.getMindMaps()).toEqual([map]);
      await api.deleteMindMap(map.id);
      expect(await api.getMindMaps()).toEqual([]);
      await expect(api.getMindMap(map.id)).rejects.toThrow("思维导图不存在");
      expect(db.run).not.toHaveBeenCalledWith("DELETE FROM mindmaps WHERE id=?", [map.id]);
      await api.deleteMindMapPermanently(map.id);
      expect(map).toBeNull();
    } finally {
      restore();
    }
  });
});
