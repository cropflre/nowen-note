// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// 模拟 Capacitor 插件代理：任何属性（包括 then）都返回一个方法，未实现的方法调用时抛错。
const calls = vi.hoisted(() => [] as string[]);
vi.mock("@capawesome/capacitor-live-update", () => ({
  LiveUpdate: new Proxy({}, {
    get: (_target, property) => (...args: unknown[]) => {
      calls.push(String(property));
      if (property === "ready") return Promise.resolve({ currentBundleId: null, previousBundleId: null, rollback: false, args });
      return Promise.reject(new Error(`"LiveUpdate.${String(property)}()" is not implemented on android`));
    },
  }),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" }, registerPlugin: () => ({}) }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

import { loadLiveUpdateBridge } from "..";

describe("插件桥接", () => {
  it("不把 Capacitor 代理交给 Promise 解析（否则安卓上会调用不存在的 then 方法）", async () => {
    const bridge = await loadLiveUpdateBridge();
    expect(calls).not.toContain("then");
    expect(typeof (bridge as unknown as { then?: unknown }).then).toBe("undefined");
    await expect(bridge.ready()).resolves.toMatchObject({ rollback: false });
    expect(calls).toEqual(["ready"]);
  });
});
