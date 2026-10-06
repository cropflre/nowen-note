import { beforeEach, describe, expect, it, vi } from "vitest";

const websocketConstructor = vi.fn();

vi.mock("@/lib/mobileLocalMode", () => ({
  isMobileLocalMode: () => true,
}));
vi.mock("@/lib/authSession", () => ({
  clearAuthTokens: vi.fn(),
}));

class MockWebSocket {
  static OPEN = 1;
  readyState = 0;
  constructor(url: string) { websocketConstructor(url); }
  addEventListener() {}
  send() {}
  close() {}
}

describe("mobile local realtime guard", () => {
  beforeEach(() => {
    vi.resetModules();
    websocketConstructor.mockClear();
    localStorage.clear();
    localStorage.setItem("nowen-token","still-kept-for-account-switch");
    Object.assign(globalThis, { WebSocket: MockWebSocket });
    Object.assign(window, { WebSocket: MockWebSocket });
  });

  it("does not construct WebSocket even when a preserved account token exists", async () => {
    const { realtime } = await import("@/lib/realtime");

    realtime.connect();
    realtime.setPresence("note-local",true);
    expect(realtime.yJoin("note-local")).toBe(false);
    realtime.setEditing("note-local",true);
    realtime.sendCursor("note-local",{line:1,ch:1});

    expect(websocketConstructor).not.toHaveBeenCalled();
    realtime.disconnect();
  });
});
