import assert from "node:assert/strict";
import test from "node:test";
import { getApplicationV3FeatureFlags, parseAppPageDeclarationsV3, buildAppRegistryV3, validatePackagedHtmlEntry } from "../src/plugins/applicationV3.js";
import { AppBridgeSessionGuardV3, APP_BRIDGE_V3_PROTOCOL, validateAppBridgeRequestV3 } from "../src/plugins/appBridgeV3.js";

const pages = [{ id: "home", title: "Home", entry: "ui/index.html", platforms: ["web", "desktop"], requiredPermissions: ["plugin-storage:read"] }];
const declared = ["plugin-storage:read"];

test("V3 gates are fail closed and depend on the pre-existing sandbox gates", () => {
  const keys = ["NOWEN_EXTENSIONS_V21", "NOWEN_UI_EXTENSIONS", "NOWEN_UI_LAYOUT_EDITOR", "NOWEN_SANDBOXED_PLUGIN_UI", "NOWEN_EXTENSION_V3_CORE", "NOWEN_EXTENSION_V3_APP_PAGES", "NOWEN_EXTENSION_V3_DASHBOARD_WIDGETS", "NOWEN_EXTENSION_V3_PLUGIN_DATA"];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(getApplicationV3FeatureFlags(), { core: false, appPages: false, dashboardWidgets: false, pluginData: false });
    process.env.NOWEN_EXTENSION_V3_CORE = "1";
    process.env.NOWEN_EXTENSION_V3_APP_PAGES = "1";
    assert.equal(getApplicationV3FeatureFlags().appPages, false);
    for (const key of keys) process.env[key] = "1";
    assert.deepEqual(getApplicationV3FeatureFlags(), { core: true, appPages: true, dashboardWidgets: true, pluginData: true });
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

test("app declaration is namespaced, packaged, scoped and validated", () => {
  assert.deepEqual(parseAppPageDeclarationsV3("nowenlab.demo", pages, declared), pages);
  for (const entry of ["../index.html", "/index.html", "https://evil.test/index.html", "//evil/index.html", "ui/%2e%2e/index.html", "ui/script.js", "ui/index.html?x=1"]) {
    assert.throws(() => validatePackagedHtmlEntry(entry), /应用入口/);
  }
  assert.throws(() => parseAppPageDeclarationsV3("nowenlab.demo", [...pages, pages[0]], declared), /重复/);
  assert.throws(() => parseAppPageDeclarationsV3("nowenlab.demo", pages, []), /权限/);
});

test("registry ignores unenabled, malformed, unsupported and legacy manifests", () => {
  const candidate = (id: string, status: string, apiVersion = 3) => ({
    id, status, manifestJson: JSON.stringify({ id, apiVersion, permissions: declared, contributes: { appPages: pages } }),
  });
  const registered = buildAppRegistryV3([
    candidate("nowenlab.demo", "enabled"), candidate("other.demo", "enabled"),
    candidate("legacy.demo", "enabled", 2), candidate("disabled.demo", "disabled"),
    { id: "broken.demo", status: "enabled", manifestJson: "{" },
  ], "web", true);
  assert.deepEqual(registered.map((app) => app.route), ["/apps/nowenlab.demo/home", "/apps/other.demo/home"]);
  assert.equal(buildAppRegistryV3([candidate("nowenlab.demo", "enabled")], "ios", true).length, 0);
  assert.deepEqual(buildAppRegistryV3([candidate("nowenlab.demo", "enabled")], "web", false), []);
});

const session = { pluginId: "nowenlab.demo", instanceId: "instance_A_123", nonce: "nonce_0123456789abcdef0123456789" };
const request = (requestId: string, params: Record<string, unknown> = {}) => ({
  protocol: APP_BRIDGE_V3_PROTOCOL, kind: "request", ...session, requestId, method: "storage.get", params,
});

test("Host Bridge wire contract rejects spoofed identities, unexpected methods, oversized and unsafe payloads", () => {
  assert.equal(validateAppBridgeRequestV3(request("req-1"), session).method, "storage.get");
  assert.throws(() => validateAppBridgeRequestV3({ ...request("r1"), nonce: "fake_0123456789012345678901234567" }, session), /INVALID_MESSAGE/);
  assert.throws(() => validateAppBridgeRequestV3({ ...request("r2"), method: "electron.execute" }, session), /INVALID_MESSAGE/);
  assert.throws(() => validateAppBridgeRequestV3(request("r3", { content: "a".repeat(70_000) }), session), /TOO_LARGE/);
  assert.throws(() => validateAppBridgeRequestV3(request("r4", JSON.parse('{"__proto__":{"a":1}}')), session), /INVALID_PAYLOAD/);
});

test("Host Bridge session guard enforces concurrency, deduplication and immediate revocation", () => {
  const guard = new AppBridgeSessionGuardV3(session);
  guard.accept(request("dup"), 500_000);
  assert.throws(() => guard.accept(request("dup"), 500_000), /DUPLICATE_REQUEST/);
  for (let i = 0; i < 15; i++) guard.accept(request("r" + i), 500_000);
  assert.throws(() => guard.accept(request("overflow"), 500_000), /RATE_LIMITED/);
  guard.complete("dup");
  guard.accept(request("next"), 500_000);
  guard.revoke();
  assert.throws(() => guard.accept(request("after"), 500_000), /SESSION_REVOKED/);
});
