import assert from "node:assert/strict";
import test from "node:test";
import {
  ContentScriptBridgeError,
  classifyTabUrl,
  createContentScriptBridge,
  type ContentScriptBridgeAdapter,
} from "../src/lib/content-script-bridge";
import { installContentScriptListener } from "../src/lib/content-script-runtime";
import { describeRuntimeMessageError } from "../src/lib/runtime-message-error";
import { CONTENT_SCRIPT_PROTOCOL_VERSION } from "../src/lib/protocol";

function pong() {
  return {
    type: "CONTENT_SCRIPT_PONG",
    protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
    contentVersion: "0.5.0",
  };
}

test("classifies normal, restricted and extension-store pages", () => {
  assert.deepEqual(classifyTabUrl("https://example.com/article"), { injectable: true });
  assert.equal(classifyTabUrl("chrome://settings").code, "PAGE_NOT_INJECTABLE");
  assert.equal(classifyTabUrl("https://chromewebstore.google.com/detail/demo").code, "PAGE_NOT_INJECTABLE");
  assert.deepEqual(classifyTabUrl("file:///tmp/note.html"), { injectable: true });
});

test("keeps a healthy content script without duplicate injection", async () => {
  let injections = 0;
  const adapter: ContentScriptBridgeAdapter = {
    getTab: async () => ({ url: "https://example.com" }),
    sendMessage: async (_tabId, message) => {
      if ((message as { type?: string }).type === "CONTENT_SCRIPT_PING") return pong();
      return { type: "EXTRACT_RESPONSE", ok: true };
    },
    injectContentScript: async () => { injections += 1; },
    delay: async () => undefined,
  };

  const bridge = createContentScriptBridge(adapter);
  const result = await bridge.request(1, { type: "EXTRACT_REQUEST", mode: "article" });
  assert.equal(injections, 0);
  assert.equal((result as { ok: boolean }).ok, true);
});

test("injects content.js after a missing or stale receiver and retries", async () => {
  let injected = false;
  let injections = 0;
  const adapter: ContentScriptBridgeAdapter = {
    getTab: async () => ({ url: "https://example.com/old-tab" }),
    sendMessage: async (_tabId, message) => {
      const type = (message as { type?: string }).type;
      if (type === "CONTENT_SCRIPT_PING") {
        if (!injected) throw new Error("Could not establish connection. Receiving end does not exist.");
        return pong();
      }
      return { type: "EXTRACT_RESPONSE", ok: true };
    },
    injectContentScript: async () => {
      injections += 1;
      injected = true;
    },
    delay: async () => undefined,
  };

  const bridge = createContentScriptBridge(adapter);
  const response = await bridge.request(5, { type: "EXTRACT_REQUEST", mode: "article" });
  assert.equal(injections, 1);
  assert.equal((response as { ok: boolean }).ok, true);
});

test("does not attempt injection on browser-protected pages", async () => {
  let injections = 0;
  const adapter: ContentScriptBridgeAdapter = {
    getTab: async () => ({ url: "edge://extensions" }),
    sendMessage: async () => { throw new Error("Receiving end does not exist"); },
    injectContentScript: async () => { injections += 1; },
    delay: async () => undefined,
  };

  const bridge = createContentScriptBridge(adapter);
  await assert.rejects(
    () => bridge.ensure(9),
    (error: unknown) => error instanceof ContentScriptBridgeError
      && error.code === "PAGE_NOT_INJECTABLE"
      && !error.message.includes("Receiving end"),
  );
  assert.equal(injections, 0);
});

test("maps local-file permission failures to an actionable message", async () => {
  const adapter: ContentScriptBridgeAdapter = {
    getTab: async () => ({ url: "file:///Users/demo/article.html" }),
    sendMessage: async () => { throw new Error("Receiving end does not exist"); },
    injectContentScript: async () => { throw new Error("Cannot access contents of url"); },
    delay: async () => undefined,
  };

  const bridge = createContentScriptBridge(adapter);
  await assert.rejects(
    () => bridge.ensure(11),
    (error: unknown) => error instanceof ContentScriptBridgeError
      && error.code === "FILE_ACCESS_REQUIRED"
      && error.message.includes("允许访问文件网址"),
  );
});

test("replaces stale and legacy listeners even when the loaded marker remains", () => {
  const removed: unknown[] = [];
  const added: unknown[] = [];
  const oldListener = () => undefined;
  const legacyListener = () => undefined;
  const nextListener = () => undefined;
  const host: Record<string, unknown> = {
    __nowenClipperLoaded: true,
    __nowenClipperState: { version: "0.4.0", listener: oldListener },
    __nowenClipperListener: legacyListener,
  };
  const runtime = {
    onMessage: {
      addListener(listener: unknown) { added.push(listener); },
      removeListener(listener: unknown) { removed.push(listener); },
    },
  };

  const state = installContentScriptListener(host, runtime as any, "0.5.0", nextListener);
  assert.deepEqual(removed, [oldListener, legacyListener]);
  assert.deepEqual(added, [nextListener]);
  assert.equal(state.version, "0.5.0");
  assert.equal((host.__nowenClipperState as { listener: unknown }).listener, nextListener);
});

test("translates popup-to-background receiver errors", () => {
  const message = describeRuntimeMessageError(
    new Error("Could not establish connection. Receiving end does not exist."),
  );
  assert.match(message, /扩展管理页/);
  assert.doesNotMatch(message, /Receiving end/);
});
