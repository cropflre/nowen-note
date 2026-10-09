import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realtime } from "../realtime";
import { setServerTransportEndpoint } from "../serverEndpointState";
const publicUrl = "https://notes.example.com";
const lanUrl = "http://192.168.1.10:3001";
class Socket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static all: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  constructor(readonly url: string) { super(); Socket.all.push(this); }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); Socket.all = [];
  localStorage.setItem("nowen-server-url", publicUrl); localStorage.setItem("nowen-token", "same-token");
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => { realtime.disconnect(); setServerTransportEndpoint(publicUrl, publicUrl); vi.unstubAllGlobals(); });

describe("WebSocket endpoint selection", () => {
  it("reconnects using LAN, replays subscriptions and ignores messages from the superseded socket", () => {
    realtime.connect(); const old = Socket.all[0]; old.open();
    realtime.subscribe("note:123"); realtime.setPresence("123", true);
    setServerTransportEndpoint(publicUrl, lanUrl);
    expect(Socket.all).toHaveLength(2);
    const current = Socket.all[1];
    expect(current.url).toBe("ws://192.168.1.10:3001/ws?token=same-token");
    current.open();
    expect(current.sent.map((value) => JSON.parse(value))).toEqual(expect.arrayContaining([
      { type: "subscribe", room: "note:123" }, { type: "presence", noteId: "123", editing: true },
    ]));
    old.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "force-logout" }) }));
    expect(localStorage.getItem("nowen-token")).toBe("same-token");
    setServerTransportEndpoint(publicUrl, publicUrl);
    expect(Socket.all[2].url).toBe("wss://notes.example.com/ws?token=same-token");
  });

  it("keeps an explicitly disconnected client disconnected when endpoints change", () => {
    realtime.connect(); realtime.disconnect();
    setServerTransportEndpoint(publicUrl, lanUrl);
    expect(Socket.all).toHaveLength(1);
  });
});
