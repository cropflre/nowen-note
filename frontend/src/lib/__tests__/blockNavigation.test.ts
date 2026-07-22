import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api.impl", () => ({ getBaseUrl: () => "/api" }));

import {
  consumeBlockNavigation,
  openInternalNoteLink,
  subscribeOpenInternalNoteLink,
} from "@/lib/blockNavigation";

describe("block link navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens ordinary note links immediately without resolving", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const received: any[] = [];
    const unsubscribe = subscribeOpenInternalNoteLink((detail) => received.push(detail));

    expect(openInternalNoteLink("note:11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(received).toEqual([{
      noteId: "11111111-1111-4111-8111-111111111111",
      blockId: null,
      href: "note:11111111-1111-4111-8111-111111111111",
      redirected: false,
    }]);
    expect(fetchMock).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("stores the final chapter block after the server follows a split chain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      note: { id: "33333333-3333-4333-8333-333333333333" },
      block: { blockId: "blk_body_alpha" },
      redirect: { redirected: true, hops: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const received: any[] = [];
    const unsubscribe = subscribeOpenInternalNoteLink((detail) => received.push(detail));

    expect(openInternalNoteLink(
      "note:11111111-1111-4111-8111-111111111111#blk:blk_body_alpha",
    )).toBe(true);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0]).toMatchObject({
      noteId: "33333333-3333-4333-8333-333333333333",
      blockId: "blk_body_alpha",
      redirected: true,
    });
    expect(consumeBlockNavigation("33333333-3333-4333-8333-333333333333")).toMatchObject({
      noteId: "33333333-3333-4333-8333-333333333333",
      blockId: "blk_body_alpha",
    });
    unsubscribe();
  });

  it("opens a chapter at the top when the old anchor was the omitted section heading", async () => {
    sessionStorage.setItem("nowen.pendingBlockNavigation", JSON.stringify({
      noteId: "stale",
      blockId: "blk_stale",
      createdAt: Date.now(),
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      note: { id: "22222222-2222-4222-8222-222222222222" },
      block: null,
      redirect: { redirected: true, toBlockId: null },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const received: any[] = [];
    const unsubscribe = subscribeOpenInternalNoteLink((detail) => received.push(detail));

    openInternalNoteLink(
      "note:11111111-1111-4111-8111-111111111111#blk:blk_heading_alpha",
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0]).toMatchObject({
      noteId: "22222222-2222-4222-8222-222222222222",
      blockId: null,
      redirected: true,
    });
    expect(sessionStorage.getItem("nowen.pendingBlockNavigation")).toBeNull();
    unsubscribe();
  });

  it("falls back to the original target when resolution is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const received: any[] = [];
    const unsubscribe = subscribeOpenInternalNoteLink((detail) => received.push(detail));

    openInternalNoteLink(
      "note:11111111-1111-4111-8111-111111111111#blk:blk_original",
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0]).toMatchObject({
      noteId: "11111111-1111-4111-8111-111111111111",
      blockId: "blk_original",
      redirected: false,
    });
    unsubscribe();
  });
});
