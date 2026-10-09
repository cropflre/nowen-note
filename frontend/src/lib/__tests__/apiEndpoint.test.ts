import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, getServerUrl, resolveAttachmentUrl } from "../api.impl";
import { getServerEndpointSnapshot, setServerTransportEndpoint } from "../serverEndpointState";
const publicUrl = "https://notes.example.com";
const lanUrl = "http://192.168.1.10:3001";
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  Object.assign(window, { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } });
  localStorage.setItem("nowen-server-url", publicUrl); localStorage.setItem("nowen-token", "same-token");
});
afterEach(() => { setServerTransportEndpoint(publicUrl, publicUrl); delete (window as any).Capacitor; vi.unstubAllGlobals(); });
describe("logical API identity versus transport", () => {
  it("records first instance identity only from the configured version request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ appVersion: "1.5.1", serverInstanceId: "instance-1" }))));
    await api.getVersion();
    expect(getServerEndpointSnapshot(publicUrl).serverInstanceId).toBe("instance-1");
    setServerTransportEndpoint(publicUrl, lanUrl);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ appVersion: "1.5.1", serverInstanceId: "other-instance" }))));
    await api.getVersion();
    expect(getServerEndpointSnapshot(publicUrl).serverInstanceId).toBe("instance-1");
    expect(getServerUrl()).toBe(publicUrl);
  });
  it("routes relative API and legacy attachments over LAN without changing the saved address", () => {
    setServerTransportEndpoint(publicUrl, lanUrl);
    expect(resolveAttachmentUrl("/api/files/a.png")).toBe(`${lanUrl}/api/files/a.png`);
    expect(resolveAttachmentUrl("attachments/a.png")).toBe(`${lanUrl}/attachments/a.png`);
    expect(getServerUrl()).toBe(publicUrl);
  });
});
