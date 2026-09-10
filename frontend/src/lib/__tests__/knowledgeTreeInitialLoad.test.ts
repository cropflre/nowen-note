import { afterEach, describe, expect, it, vi } from "vitest";

import { loadKnowledgeTreeOnEntry } from "../knowledgeTreeInitialLoad";

afterEach(() => {
  vi.useRealTimers();
});

describe("loadKnowledgeTreeOnEntry", () => {
  it("silently retries transient startup failures before succeeding", async () => {
    vi.useFakeTimers();
    const load = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(Object.assign(new Error("starting"), { status: 503 }))
      .mockResolvedValue("ready");

    const result = loadKnowledgeTreeOnEntry(load);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("ready");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("does not delay a non-retryable response", async () => {
    const error = Object.assign(new Error("unauthorized"), { status: 401 });
    const load = vi.fn().mockRejectedValue(error);

    await expect(loadKnowledgeTreeOnEntry(load)).rejects.toBe(error);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
