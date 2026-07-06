import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

describe("api.importNotes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("splits import requests before a multi-note JSON body can exceed the string limit", async () => {
    const originalStringify = JSON.stringify;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = originalStringify({
        success: true,
        count: init?.body ? JSON.parse(String(init.body)).notes.length : 0,
        notebookId: "nb-1",
        notebookIds: ["nb-1"],
        notes: [],
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(JSON, "stringify").mockImplementation((value: any, ...args: any[]) => {
      if (value && Array.isArray(value.notes) && value.notes.length > 1) {
        throw new RangeError("Invalid string length");
      }
      return originalStringify(value, ...args);
    });

    const result = await api.importNotes([
      { title: "A", content: "{}", contentText: "A" },
      { title: "B", content: "{}", contentText: "B" },
      { title: "C", content: "{}", contentText: "C" },
    ]);

    expect(result.success).toBe(true);
    expect(result.count).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const batchSizes = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).notes.length);
    expect(batchSizes).toEqual([1, 1, 1]);
  });
});
