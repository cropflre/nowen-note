import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realtime } from "../realtime";
import { setMobileSyncEnabled } from "../mobileSyncStatus";
vi.mock("../authSession", () => ({ clearAuthTokens: vi.fn() }));
const sockets: Socket[] = [];
class Socket extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  send = vi.fn();
  constructor(public url: string) { super(); sockets.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
beforeEach(() => {
  vi.useFakeTimers(); realtime.disconnect();
  Object.assign(window, { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } });
  setMobileSyncEnabled(false); localStorage.clear(); sockets.length = 0;
  localStorage.setItem("nowen-token", "token"); localStorage.setItem("nowen-server-url", "https://notes.example.com");
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => { realtime.disconnect(); vi.useRealTimers(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "Capacitor"); });
describe("Android realtime follows the sync switch", () => {
  it("does not connect while disabled and restores subscriptions after re-enabling", async () => {
    realtime.subscribe("note:n1"); realtime.connect();
    expect(sockets).toHaveLength(0);
    setMobileSyncEnabled(true); sockets[0].open();
    expect(sockets[0].send).toHaveBeenCalledWith(JSON.stringify({ type: "subscribe", room: "note:n1" }));
    setMobileSyncEnabled(false);
    expect(sockets[0].readyState).toBe(3);
    realtime.connect(); await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(1);
    setMobileSyncEnabled(true); sockets[1].open();
    expect(sockets[1].send).toHaveBeenCalledWith(JSON.stringify({ type: "subscribe", room: "note:n1" }));
  });
  it("does not apply the native sync switch to browser connections", () => {
    Reflect.deleteProperty(window, "Capacitor"); realtime.connect();
    expect(sockets).toHaveLength(1);
  });
});
