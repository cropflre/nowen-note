// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMobileWebStartupCache,
  installMobileWebStartupBridge,
  shouldEnableMobileWebStartup,
} from "@/lib/mobileWebStartupBridge";
import type { MobileBootstrapPayload } from "@/lib/mobileStartupBridge";

const payload: MobileBootstrapPayload = {
  schemaVersion: 1,
  workspaceId: "personal",
  generatedAt: 1,
  notes: [
    {
      id: "note-1",
      notebookId: "notebook-1",
      title: "First",
      contentText: "preview",
      contentLength: 4096,
      isPinned: 0,
      isFavorite: 0,
      sortOrder: 0,
      createdAt: "2026-07-12 00:00:00",
      updatedAt: "2026-07-12 00:00:00",
    },
  ],
  notebooks: [{ id: "notebook-1", parentId: null }],
  tags: [{ id: "tag-1", name: "Tag" }],
  sharedNoteIds: ["note-1"],
  sharedNotebooks: [],
  preferences: { showNoteListUpdatedTime: true },
};

const originalFetch = window.fetch;

afterEach(() => {
  clearMobileWebStartupCache();
  window.fetch = originalFetch;
  delete (window as typeof window & Record<string, unknown>).__nowenMobileWebStartupBridgeInstalled;
  vi.restoreAllMocks();
});

describe("mobile web startup runtime detection", () => {
  it("enables Android/iOS mobile web and touch-first narrow PWAs", () => {
    expect(shouldEnableMobileWebStartup({ userAgent: "Mozilla/5.0 (Linux; Android 15) Mobile" })).toBe(true);
    expect(shouldEnableMobileWebStartup({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" })).toBe(true);
    expect(shouldEnableMobileWebStartup({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      maxTouchPoints: 5,
      coarsePointer: true,
      narrowViewport: true,
    })).toBe(true);
  });

  it("does not double-install over native Android or ordinary desktop web", () => {
    expect(shouldEnableMobileWebStartup({
      nativeAndroid: true,
      userAgent: "Mozilla/5.0 (Linux; Android 15) Mobile",
    })).toBe(false);
    expect(shouldEnableMobileWebStartup({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      maxTouchPoints: 0,
      coarsePointer: false,
      narrowViewport: false,
    })).toBe(false);
  });
});

describe("mobile web startup fetch coalescing", () => {
  it("serves duplicate collection reads from one compact bootstrap response", async () => {
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://nas.test/");
      if (url.pathname === "/api/user-preferences/mobile-bootstrap") {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fallback request: ${url.pathname}`);
    });
    window.fetch = transport as typeof fetch;

    const cleanup = installMobileWebStartupBridge({ force: true });
    expect(cleanup).toBeTypeOf("function");

    const [notesResponse, notebooksResponse, tagsResponse, sharesResponse, preferencesResponse] = await Promise.all([
      window.fetch("https://nas.test/api/notes?sortBy=updatedAt&sortOrder=desc&workspaceId=personal", {
        headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      }),
      window.fetch("https://nas.test/api/notebooks?workspaceId=personal", {
        headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      }),
      window.fetch("https://nas.test/api/tags?workspaceId=personal", {
        headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      }),
      window.fetch("https://nas.test/api/shares/status/batch", {
        headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      }),
      window.fetch("https://nas.test/api/user-preferences", {
        headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      }),
    ]);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(String(transport.mock.calls[0][0])).toContain("/api/user-preferences/mobile-bootstrap?workspaceId=personal");
    expect(await notesResponse.json()).toEqual(payload.notes);
    expect(await notebooksResponse.json()).toEqual(payload.notebooks);
    expect(await tagsResponse.json()).toEqual(payload.tags);
    expect(await sharesResponse.json()).toEqual(payload.sharedNoteIds);
    expect(await preferencesResponse.json()).toEqual(payload.preferences);
    expect(notesResponse.headers.get("X-Nowen-Mobile-Bootstrap")).toBe("web-hit");

    cleanup?.();
  });

  it("invalidates protected note snapshots when folder lock state changes", async () => {
    let locked = false;
    let bootstrapReads = 0;
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://nas.test/");
      if (url.pathname !== "/api/user-preferences/mobile-bootstrap") {
        throw new Error(`unexpected request: ${url.pathname}`);
      }
      bootstrapReads++;
      return new Response(JSON.stringify({
        ...payload,
        notes: locked ? [] : [{ ...payload.notes[0], title: "Previously unlocked secret" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    window.fetch = transport as typeof fetch;
    const cleanup = installMobileWebStartupBridge({ force: true });

    const url = "https://nas.test/api/notes?workspaceId=personal";
    const headers = { Authorization: "Bearer active-account" };
    const first = await window.fetch(url, { headers });
    expect((await first.json())[0].title).toBe("Previously unlocked secret");
    locked = true;
    window.dispatchEvent(new Event("nowen:knowledge-tree-password-session-changed"));
    const second = await window.fetch(url, { headers });
    expect(await second.json()).toEqual([]);
    expect(bootstrapReads).toBe(2);
    cleanup?.();
  });

  it("never publishes a snapshot fetched before folder locking", async () => {
    let release!: (value: Response) => void;
    const pendingBootstrap = new Promise<Response>((resolve) => { release = resolve; });
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://nas.test/");
      if (url.pathname === "/api/user-preferences/mobile-bootstrap") return pendingBootstrap;
      if (url.pathname === "/api/notes") {
        return new Response(JSON.stringify([]), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected: ${url.pathname}`);
    });
    window.fetch = transport as typeof fetch;
    const cleanup = installMobileWebStartupBridge({ force: true });
    const request = window.fetch("https://nas.test/api/notes?workspaceId=personal", {
      headers: { Authorization: "Bearer account" },
    });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("nowen:knowledge-tree-password-locked"));
    release(new Response(JSON.stringify({
      ...payload, notes: [{ ...payload.notes[0], title: "SECRET FROM OLD SNAPSHOT" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const response = await request;
    expect(await response.json()).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(2);
    cleanup?.();
  });

  it("falls back to the original endpoint when an older backend lacks bootstrap", async () => {
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://nas.test/");
      if (url.pathname === "/api/user-preferences/mobile-bootstrap") {
        return new Response("not found", { status: 404 });
      }
      if (url.pathname === "/api/notes") {
        return new Response(JSON.stringify([{ id: "legacy" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    });
    window.fetch = transport as typeof fetch;

    const cleanup = installMobileWebStartupBridge({ force: true });
    const response = await window.fetch("https://nas.test/api/notes?workspaceId=personal", {
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    });

    expect(await response.json()).toEqual([{ id: "legacy" }]);
    expect(transport).toHaveBeenCalledTimes(2);
    cleanup?.();
  });
});
