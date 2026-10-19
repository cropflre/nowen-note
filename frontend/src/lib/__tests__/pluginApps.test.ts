import { describe, expect, it, vi, afterEach } from "vitest";
import { MessageChannel } from "node:worker_threads";
import { parsePluginAppPath, loadPluginAppPins, savePluginAppPins } from "../pluginApps";
import { connectPluginAppFrame } from "../pluginAppChannel";
import { inferBrowserServerBaseUrl } from "../serverUrl";
import { buildAppPathUrl, resolveCurrentAppPathname } from "../appPathNavigation";

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("V3 app navigation and account-local pins", () => {
  it("keeps app management routes distinct from server proxy prefixes", () => {
    expect(inferBrowserServerBaseUrl({ protocol: "https:", origin: "https://notes.example", pathname: "/apps/manage" })).toBe("");
    expect(inferBrowserServerBaseUrl({ protocol: "https:", origin: "https://notes.example", pathname: "/nowen/apps/manage" })).toBe("https://notes.example/nowen");
    expect(resolveCurrentAppPathname("https://notes.example/nowen/apps/manage")).toBe("/apps/manage");
    expect(buildAppPathUrl("/apps", "https://notes.example/nowen/apps/manage")).toBe("/nowen/apps");
  });
  it("accepts only namespaced app routes without encoded or core-route overrides", () => {
    expect(parsePluginAppPath("/apps").matched).toBe(true);
    expect(parsePluginAppPath("/apps/manage")).toEqual({ matched: true, manage: true });
    expect(parsePluginAppPath("/apps/studio")).toEqual({ matched: true, studio: true });
    expect(parsePluginAppPath("/apps/personal/01234567-89ab-cdef-0123-456789abcdef")).toEqual({ matched: true, personalId: "01234567-89ab-cdef-0123-456789abcdef" });
    expect(parsePluginAppPath("/apps/studio/01234567-89ab-cdef-0123-456789abcdef")).toEqual({ matched: true, studio: true, studioId: "01234567-89ab-cdef-0123-456789abcdef" });
    expect(parsePluginAppPath("/apps/nowenlab.hello-app/home")).toEqual({ matched: true, pluginId: "nowenlab.hello-app", pageId: "home" });
    for (const path of ["/settings", "/apps/../settings", "/apps/%2e%2e/home", "/apps/nowenlab.app/home?x=1", "/apps/core/home", "/apps/personal/../settings", "/apps/studio/bad"]) expect(parsePluginAppPath(path).matched).toBe(false);
  });
  it("does not inherit another account's pinned apps", () => {
    const token = (id: string) => `x.${btoa(JSON.stringify({ userId: id }))}.x`;
    localStorage.setItem("nowen-token", token("alice")); savePluginAppPins(["nowenlab.hello-app/home"]);
    localStorage.setItem("nowen-token", token("bob")); expect(loadPluginAppPins()).toEqual([]);
    localStorage.setItem("nowen-token", token("alice")); expect(loadPluginAppPins()).toEqual(["nowenlab.hello-app/home"]);
  });
});
describe("V3 MessageChannel identity", () => {
  const session = { instanceId: "instance_12345", pluginId: "nowenlab.hello-app", nonce: "nonce_12345678", documentPath: "/plugin-ui-v3/one-use-ticket", expiresAt: Date.now() + 10000 };
  function setup(call: (message: any) => Promise<unknown> = vi.fn(async () => ({ ok: true }))) {
    vi.stubGlobal("MessageChannel", MessageChannel);
    const frame = document.createElement("iframe"); document.body.append(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => undefined);
    const fail = vi.fn(), ready = vi.fn();
    const connection = connectPluginAppFrame(frame, session, call, fail, ready);
    const transfer = post.mock.calls[0] as unknown as [unknown, string, Transferable[]];
    const port = transfer[2][0] as unknown as MessagePort;
    port.start();
    return { port, connection, call, fail, ready, cleanup: () => { connection.close(); port.close(); frame.remove(); } };
  }
  it("uses the exact frame and transferred port, then rejects forged identity", async () => {
    const host = setup();
    try {
      host.port.postMessage({ protocol: "nowen.plugin-ui.v3", kind: "ready", pluginId: session.pluginId, instanceId: session.instanceId, nonce: session.nonce });
      await vi.waitFor(() => expect(host.ready).toHaveBeenCalledOnce());
      host.port.postMessage({ protocol: "nowen.plugin-ui.v3", kind: "request", pluginId: session.pluginId, instanceId: session.instanceId, nonce: "forged", requestId: "a", method: "storage.get", params: {} });
      await vi.waitFor(() => expect(host.fail).toHaveBeenCalledOnce()); expect(host.call).not.toHaveBeenCalled();
    } finally { host.cleanup(); }
  });
  it("rejects cyclic structured-clone payloads without forwarding HTTP calls", async () => {
    const host = setup();
    try {
      const identity = { protocol: "nowen.plugin-ui.v3", pluginId: session.pluginId, instanceId: session.instanceId, nonce: session.nonce };
      host.port.postMessage({ ...identity, kind: "ready" }); await vi.waitFor(() => expect(host.ready).toHaveBeenCalledOnce());
      const params: any = {}; params.self = params;
      host.port.postMessage({ ...identity, kind: "request", requestId: "cycle", method: "storage.set", params });
      await vi.waitFor(() => expect(host.fail).toHaveBeenCalledOnce()); expect(host.call).not.toHaveBeenCalled();
    } finally { host.cleanup(); }
  });
  it("relays only responses bound to this plugin, instance and request", async () => {
    const identity = { protocol: "nowen.plugin-ui.v3", pluginId: session.pluginId, instanceId: session.instanceId, nonce: session.nonce };
    const call = vi.fn(async message => ({ ...identity, kind: "response", requestId: message.requestId, ok: true, data: "stored" }));
    const host = setup(call), replies: any[] = []; host.port.onmessage = event => replies.push(event.data);
    try {
      host.port.postMessage({ ...identity, kind: "ready" }); await vi.waitFor(() => expect(host.ready).toHaveBeenCalledOnce());
      host.port.postMessage({ ...identity, kind: "request", requestId: "read-1", method: "storage.get", params: { key: "message" } });
      await vi.waitFor(() => expect(replies.some(message => message.kind === "response" && message.data === "stored")).toBe(true));
      expect(host.fail).not.toHaveBeenCalled();
    } finally { host.cleanup(); }
  });
  it("closes the channel instead of delivering a response for another plugin", async () => {
    const identity = { protocol: "nowen.plugin-ui.v3", pluginId: session.pluginId, instanceId: session.instanceId, nonce: session.nonce };
    const host = setup(vi.fn(async message => ({ ...identity, pluginId: "other.app", kind: "response", requestId: message.requestId, ok: true, data: "foreign private data" }))), replies: any[] = [];
    host.port.onmessage = event => replies.push(event.data);
    try {
      host.port.postMessage({ ...identity, kind: "ready" }); await vi.waitFor(() => expect(host.ready).toHaveBeenCalledOnce());
      host.port.postMessage({ ...identity, kind: "request", requestId: "read-1", method: "storage.get", params: { key: "message" } });
      await vi.waitFor(() => expect(host.fail).toHaveBeenCalledOnce());
      expect(replies.some(message => message.kind === "response")).toBe(false);
    } finally { host.cleanup(); }
  });
});
