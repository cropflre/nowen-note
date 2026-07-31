import { afterEach, describe, expect, it, vi } from "vitest";
import { isAiAskRequest, withAbortableAiFetch } from "@/lib/abortableAiAsk";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("abortable AI ask bridge", () => {
  it("recognizes both legacy and reliable streaming endpoints", () => {
    expect(isAiAskRequest("/api/ai/ask")).toBe(true);
    expect(isAiAskRequest("/api/user-preferences/ai-reliable/ask?workspaceId=demo")).toBe(true);
    expect(isAiAskRequest("/api/notes")).toBe(false);
  });

  it("only injects the controller signal into AI ask requests", async () => {
    const calls: Array<{ url: string; signal?: AbortSignal | null }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, signal: init?.signal });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const controller = new AbortController();
    await withAbortableAiFetch(controller, async () => {
      await fetch("/api/notes");
      await fetch("/api/ai/ask", { method: "POST" });
    });

    expect(calls[0].signal).toBeUndefined();
    expect(calls[1].signal).toBe(controller.signal);
    expect(globalThis.fetch).not.toBeUndefined();
  });
});
