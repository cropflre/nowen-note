/**
 * optimisticLockApi.ts 单元测试
 *
 * 关键路径：
 *   1) send 成功 —— 不走 reconcile
 *   2) 409 + err.currentVersion —— 用 latest 重放一次
 *   3) 409 + 无 currentVersion，fetchLatestVersion 提供 —— 用它的值重放
 *   4) 409 + 无任何 latest —— 抛原错误
 *   5) 409 + onAbort() → true —— 抛 aborted 错误
 *   6) 非 409 错误 —— 直接透传
 *   7) is409Error / isAborted 边界
 *
 * 注意：这里只测纯函数，不涉及 api 模块，send/fetchLatestVersion 全用 mock。
 */
import { describe, expect, it, vi } from "vitest";
import {
  is409Error,
  isAborted,
  putWithReconcile,
} from "@/lib/optimisticLockApi";

function make409(currentVersion?: number): Error & Record<string, any> {
  const e: any = new Error("409 conflict");
  e.status = 409;
  if (typeof currentVersion === "number") e.currentVersion = currentVersion;
  return e;
}

describe("is409Error", () => {
  it("识别 status=409", () => {
    expect(is409Error({ status: 409 })).toBe(true);
  });
  it("识别 message 含 409/conflict", () => {
    expect(is409Error(new Error("Version conflict"))).toBe(true);
    expect(is409Error(new Error("HTTP 409"))).toBe(true);
  });
  it("非 409 返回 false", () => {
    expect(is409Error(new Error("500 server error"))).toBe(false);
    expect(is409Error(null)).toBe(false);
    expect(is409Error(undefined)).toBe(false);
  });
});

describe("putWithReconcile", () => {
  it("首发成功直接返回，不调用 fetchLatestVersion", async () => {
    const send = vi.fn(async (_v: number) => ({ ok: true, v: _v }));
    const fetchLatestVersion = vi.fn();

    const result = await putWithReconcile({
      initialVersion: 3,
      send,
      fetchLatestVersion,
    });

    expect(result).toEqual({ ok: true, v: 3 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(3);
    expect(fetchLatestVersion).not.toHaveBeenCalled();
  });

  it("409 + err.currentVersion：用它重放一次", async () => {
    let attempt = 0;
    const send = vi.fn(async (v: number) => {
      attempt++;
      if (attempt === 1) throw make409(7);
      return { ok: true, v };
    });

    const result = await putWithReconcile({ initialVersion: 3, send });

    expect(result).toEqual({ ok: true, v: 7 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, 3);
    expect(send).toHaveBeenNthCalledWith(2, 7);
  });

  it("409 无 currentVersion：走 fetchLatestVersion", async () => {
    let attempt = 0;
    const send = vi.fn(async (v: number) => {
      attempt++;
      if (attempt === 1) throw make409(); // 无 currentVersion
      return { ok: true, v };
    });
    const fetchLatestVersion = vi.fn(async () => 9);

    const result = await putWithReconcile({
      initialVersion: 3,
      send,
      fetchLatestVersion,
    });

    expect(result).toEqual({ ok: true, v: 9 });
    expect(fetchLatestVersion).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(2, 9);
  });

  it("fetchLatestVersion 抛错时抛原始 409", async () => {
    const send = vi.fn(async (_v: number) => {
      throw make409();
    });
    const fetchLatestVersion = vi.fn(async () => {
      throw new Error("network down");
    });

    await expect(
      putWithReconcile({ initialVersion: 3, send, fetchLatestVersion }),
    ).rejects.toMatchObject({ status: 409 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("409 + 无 fetchLatestVersion 且无 currentVersion：抛原 409", async () => {
    const send = vi.fn(async (_v: number) => {
      throw make409();
    });
    await expect(
      putWithReconcile({ initialVersion: 3, send }),
    ).rejects.toMatchObject({ status: 409 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("onAbort=true：抛 aborted 错误，不重放", async () => {
    const send = vi.fn(async (_v: number) => {
      throw make409(7);
    });
    const onAbort = vi.fn(() => true);

    try {
      await putWithReconcile({ initialVersion: 3, send, onAbort });
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(isAborted(err)).toBe(true);
    }
    expect(send).toHaveBeenCalledTimes(1); // 未重放
  });

  it("onAbort=false：正常重放", async () => {
    let attempt = 0;
    const send = vi.fn(async (v: number) => {
      attempt++;
      if (attempt === 1) throw make409(7);
      return { ok: true, v };
    });
    const onAbort = vi.fn(() => false);

    const result = await putWithReconcile({
      initialVersion: 3,
      send,
      onAbort,
    });
    expect(result).toEqual({ ok: true, v: 7 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("非 409 错误原样抛出，不调用 fetchLatestVersion", async () => {
    const send = vi.fn(async (_v: number) => {
      throw new Error("500 internal");
    });
    const fetchLatestVersion = vi.fn();

    await expect(
      putWithReconcile({ initialVersion: 3, send, fetchLatestVersion }),
    ).rejects.toThrow("500 internal");
    expect(fetchLatestVersion).not.toHaveBeenCalled();
  });
});

describe("isAborted", () => {
  it("识别 aborted 标志", () => {
    const e: any = new Error("x");
    e.aborted = true;
    expect(isAborted(e)).toBe(true);
  });
  it("非 aborted 错误返回 false", () => {
    expect(isAborted(new Error("x"))).toBe(false);
    expect(isAborted(null)).toBe(false);
  });
});
