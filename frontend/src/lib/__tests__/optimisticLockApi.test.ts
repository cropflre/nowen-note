import { describe, expect, it, vi } from "vitest";
import {
  is409Error,
  isAborted,
  putWithReconcile,
} from "@/lib/optimisticLockApi";

function make409(currentVersion?: number): Error & Record<string, any> {
  const error: any = new Error("409 conflict");
  error.status = 409;
  error.code = "VERSION_CONFLICT";
  if (typeof currentVersion === "number") error.currentVersion = currentVersion;
  return error;
}

describe("is409Error", () => {
  it("recognizes status, code and conflict messages", () => {
    expect(is409Error({ status: 409 })).toBe(true);
    expect(is409Error({ code: "VERSION_CONFLICT" })).toBe(true);
    expect(is409Error(new Error("Version conflict"))).toBe(true);
    expect(is409Error(new Error("HTTP 409"))).toBe(true);
  });

  it("returns false for unrelated failures", () => {
    expect(is409Error(new Error("500 server error"))).toBe(false);
    expect(is409Error(null)).toBe(false);
  });
});

describe("putWithReconcile", () => {
  it("returns a successful first attempt unchanged", async () => {
    const send = vi.fn(async (version: number) => ({ ok: true, version }));
    const fetchLatestVersion = vi.fn();

    await expect(putWithReconcile({
      initialVersion: 3,
      send,
      fetchLatestVersion,
    })).resolves.toEqual({ ok: true, version: 3 });

    expect(send).toHaveBeenCalledTimes(1);
    expect(fetchLatestVersion).not.toHaveBeenCalled();
  });

  it("stops on 409 by default even when currentVersion is available", async () => {
    const send = vi.fn().mockRejectedValue(make409(7));

    await expect(putWithReconcile({ initialVersion: 3, send }))
      .rejects.toMatchObject({ status: 409, currentVersion: 7 });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(3);
  });

  it("retries with currentVersion only after explicit opt-in", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(make409(7))
      .mockResolvedValueOnce({ ok: true, version: 8 });

    await expect(putWithReconcile({
      initialVersion: 3,
      send,
      retryOnConflict: true,
    })).resolves.toEqual({ ok: true, version: 8 });

    expect(send).toHaveBeenNthCalledWith(1, 3);
    expect(send).toHaveBeenNthCalledWith(2, 7);
  });

  it("may fetch the latest version for an explicitly replay-safe mutation", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(make409())
      .mockResolvedValueOnce({ ok: true, version: 10 });
    const fetchLatestVersion = vi.fn().mockResolvedValue(9);

    await expect(putWithReconcile({
      initialVersion: 3,
      send,
      fetchLatestVersion,
      retryOnConflict: true,
    })).resolves.toEqual({ ok: true, version: 10 });

    expect(fetchLatestVersion).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(2, 9);
  });

  it("enriches a default conflict without replaying it", async () => {
    const send = vi.fn().mockRejectedValue(make409());
    const fetchLatestVersion = vi.fn().mockResolvedValue(9);

    await expect(putWithReconcile({
      initialVersion: 3,
      send,
      fetchLatestVersion,
    })).rejects.toMatchObject({ status: 409, currentVersion: 9 });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps the original conflict when the version lookup fails", async () => {
    const send = vi.fn().mockRejectedValue(make409());
    const fetchLatestVersion = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(putWithReconcile({
      initialVersion: 3,
      send,
      fetchLatestVersion,
    })).rejects.toMatchObject({ status: 409 });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("honors onAbort before an optional retry", async () => {
    const send = vi.fn().mockRejectedValue(make409(7));
    const onAbort = vi.fn(() => true);

    try {
      await putWithReconcile({
        initialVersion: 3,
        send,
        onAbort,
        retryOnConflict: true,
      });
      expect.fail("should have thrown");
    } catch (error) {
      expect(isAborted(error)).toBe(true);
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("passes non-conflict failures through", async () => {
    const send = vi.fn().mockRejectedValue(new Error("500 internal"));
    const fetchLatestVersion = vi.fn();

    await expect(putWithReconcile({
      initialVersion: 3,
      send,
      fetchLatestVersion,
    })).rejects.toThrow("500 internal");

    expect(fetchLatestVersion).not.toHaveBeenCalled();
  });
});

describe("isAborted", () => {
  it("recognizes the aborted marker", () => {
    const error: any = new Error("x");
    error.aborted = true;
    expect(isAborted(error)).toBe(true);
    expect(isAborted(new Error("x"))).toBe(false);
  });
});
