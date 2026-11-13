import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { parsePluginManifest } from "../src/plugins/manifest.js";
import { validatePluginPackage } from "../src/plugins/packageValidator.js";
import { PluginPackageInstaller } from "../src/plugins/packageInstaller.js";
import { getApplicationV3FeatureFlags, parseAppPageDeclarationsV3, buildAppRegistryV3, validatePackagedHtmlEntry } from "../src/plugins/applicationV3.js";
import { NOWEN_VERSION } from "../src/plugins/types.js";
import { getExtensionPlatformFeatureFlags } from "../src/plugins/featureFlags.js";
import { AppBridgeSessionGuardV3, APP_BRIDGE_V3_PROTOCOL, APP_BRIDGE_V3_MAX_REQUESTS_PER_SESSION, validateAppBridgeRequestV3 } from "../src/plugins/appBridgeV3.js";

const pages = [{ id: "home", title: "Home", entry: "ui/index.html", platforms: ["web", "desktop"], requiredPermissions: ["plugin-storage:read"] }];
const declared = ["plugin-storage:read"];

test("V3 apps open by default on 1.5.3 while explicit shutdown and legacy gates remain effective", () => {
  const keys = ["NOWEN_EXTENSIONS_V21", "NOWEN_UI_EXTENSIONS", "NOWEN_UI_LAYOUT_EDITOR", "NOWEN_SANDBOXED_PLUGIN_UI", "NOWEN_EXTENSION_V3_CORE", "NOWEN_EXTENSION_V3_APP_PAGES", "NOWEN_EXTENSION_V3_DASHBOARD_WIDGETS", "NOWEN_EXTENSION_V3_PLUGIN_DATA"];
  const previous = keys.map(key => process.env[key]);
  try {
    keys.forEach(key => delete process.env[key]);
    assert.equal(NOWEN_VERSION, "1.5.3");
    assert.equal(NOWEN_VERSION, JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
    assert.deepEqual(getApplicationV3FeatureFlags(), { core: true, appPages: true, dashboardWidgets: true, pluginData: true, inspectors: false });
    assert.equal(getExtensionPlatformFeatureFlags().extensionsV21, false);
    for (const key of keys.slice(0, 6)) {
      process.env[key] = "0";
      assert.equal(getApplicationV3FeatureFlags().appPages, false, key);
      delete process.env[key];
    }
    process.env.NOWEN_EXTENSION_V3_CORE = "unrecognized";
    assert.equal(getApplicationV3FeatureFlags().appPages, false);
    keys.forEach(key => { process.env[key] = "1"; });
    assert.deepEqual(getApplicationV3FeatureFlags(), { core: true, appPages: true, dashboardWidgets: true, pluginData: true, inspectors: false });
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


const GATES = ["NOWEN_EXTENSIONS_V21", "NOWEN_UI_EXTENSIONS", "NOWEN_UI_LAYOUT_EDITOR", "NOWEN_SANDBOXED_PLUGIN_UI", "NOWEN_EXTENSION_V3_CORE", "NOWEN_EXTENSION_V3_APP_PAGES"] as const;
async function enabledV3<T>(fn: () => Promise<T> | T): Promise<T> {
  const saved = GATES.map((k) => process.env[k]);
  try {
    GATES.forEach((k) => { process.env[k] = "1"; });
    return await fn();
  } finally {
    GATES.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
}
const asset = (s: string | Buffer) => "sha256:" + crypto.createHash("sha256").update(s).digest("hex");
const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>Hello Nowen V3</body></html>';
const script = 'document.body.dataset.v3 = "1";';
function manifestV3() {
  return {
    id: "nowenlab.demo", name: "Hello V3", description: "UI asset installation test", version: "0.1.0",
    apiVersion: 3, publisher: "nowenlab", engines: { nowen: ">=1.5.3" },
    runtime: "declarative", categories: ["productivity"],
    repository: "https://github.com/cropflre/nowen-note", license: "MIT",
    permissions: ["plugin-storage:read"],
    contributes: { appPages: pages, uiAssets: { "ui/index.html": asset(html), "ui/app.js": asset(script) } },
  };
}
async function packV3(overrides: { manifest?: any; html?: string; extra?: Record<string, string | Buffer> } = {}) {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(overrides.manifest || manifestV3()));
  zip.file("ui/index.html", overrides.html ?? html);
  zip.file("ui/app.js", script);
  for (const [path, content] of Object.entries(overrides.extra || {})) zip.file(path, content);
  return zip.generateAsync({ type: "nodebuffer" });
}
test("V3 installs on the real 1.5.3 host and still enforces version and shutdown gates", async () => {
  await enabledV3(() => {
    assert.equal(parsePluginManifest(manifestV3()).apiVersion, 3);
    assert.throws(() => parsePluginManifest(manifestV3(), { currentVersion: "1.5.2" }), /当前版本为 1.5.2/);
    assert.throws(() => parsePluginManifest({ ...manifestV3(), engines: { nowen: ">=1.6.0" } }), /当前版本为 1.5.3/);
    assert.throws(() => parsePluginManifest({ ...manifestV3(), apiVersion: 2 }));
    assert.throws(() => parsePluginManifest({ ...manifestV3(), engines: { nowen: ">=1.5.0" } }), /V3 插件必须/);
    process.env.NOWEN_EXTENSION_V3_APP_PAGES = "0";
    assert.throws(() => parsePluginManifest(manifestV3()), (error: any) => error.code === "PLUGIN_V3_FEATURE_DISABLED");
    process.env.NOWEN_EXTENSION_V3_APP_PAGES = "1";
    const bad = manifestV3();
    bad.contributes.appPages = [{ ...pages[0], entry: "https://evil.test/attack.html" }];
    assert.throws(() => parsePluginManifest(bad));
  });
});

test("V3 accepts a hashed UI bundle and rejects altered, undeclared or unsafe resources", async () => {
  await enabledV3(async () => {
    const opts = { currentVersion: "1.5.3" };
    const good = await validatePluginPackage(await packV3(), opts);
    assert.equal(good.manifest.apiVersion, 3);
    assert.equal(good.fileCount, 3);
    await assert.rejects(async () => validatePluginPackage(await packV3({ html: "tampered" }), opts), /SHA-256 不匹配/);
    await assert.rejects(async () => validatePluginPackage(await packV3({ extra: { "ui/unlisted.js": "steal()" } }), opts), /未登记 SHA-256/);
    await assert.rejects(async () => validatePluginPackage(await packV3({ extra: { "backend/runner.js": "steal()" } }), opts), /UI 资源必须位于/);
    await assert.rejects(async () => validatePluginPackage(await packV3({ extra: { "ui/evil.wasm": "code" } }), opts), /UI 资源必须位于/);
  });
});

test("V3 icons and screenshots cannot exempt scripts from the UI asset contract", async () => {
  await enabledV3(async () => {
    for (const field of ["icon", "screenshots"] as const) {
      for (const file of ["backend/payload.js", "ui/payload.js"]) {
        const manifest = { ...manifestV3(), [field]: field === "icon" ? file : [file] };
        await assert.rejects(async () => validatePluginPackage(await packV3({ manifest, extra: { [file]: script } }), { currentVersion: "1.5.3" }));
        (manifest.contributes.uiAssets as Record<string, string>)[file] = asset(script);
        await assert.rejects(async () => validatePluginPackage(await packV3({ manifest, extra: { [file]: script } }), { currentVersion: "1.5.3" }));
      }
    }
  });
});

test("V3 ZIP and development resources share image path and integrity rules", async () => {
  await enabledV3(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-v3-assets-test-"));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    try {
      const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
      const files = { "ui/index.html": html, "ui/app.js": script, "ui/icon.png": image, "ui/screenshot.png": image };
      const manifest = { ...manifestV3(), icon: "ui/icon.png", screenshots: ["ui/screenshot.png"] };
      const assets = manifest.contributes.uiAssets as Record<string, string>;
      assets[manifest.icon] = asset(image);
      assets[manifest.screenshots[0]] = asset(image);
      fs.mkdirSync(path.join(directory, "ui"));
      for (const [file, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, file), bytes);
      const installer = new PluginPackageInstaller();
      const options = { currentVersion: "1.5.3" };
      const inspect = async () => {
        fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
        await validatePluginPackage(await packV3({ manifest, extra: files }), options);
        await installer.inspectDevelopmentDirectory(directory, options);
      };
      await inspect();
      for (const file of [manifest.icon, manifest.screenshots[0]]) {
        delete assets[file];
        fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
        await assert.rejects(() => installer.inspectDevelopmentDirectory(directory, options));
        await assert.rejects(async () => validatePluginPackage(await packV3({ manifest, extra: files }), options));
        assets[file] = asset(image);
        fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
        fs.writeFileSync(path.join(directory, file), "tampered");
        await assert.rejects(() => installer.inspectDevelopmentDirectory(directory, options), /完整性/);
        await assert.rejects(async () => validatePluginPackage(await packV3({ manifest, extra: { ...files, [file]: "tampered" } }), options), /SHA-256/);
        fs.writeFileSync(path.join(directory, file), image);
      }
      manifest.icon = "assets/icon.png";
      fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
      await assert.rejects(() => installer.inspectDevelopmentDirectory(directory, options));
      await assert.rejects(async () => validatePluginPackage(await packV3({ manifest, extra: { ...files, [manifest.icon]: image } }), options));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("V3 rejects ranges admitting pre-1.5.3 hosts and malformed comparator suffixes", async () => {
  await enabledV3(() => {
    for (const range of [">=1.5.0", ">=1.5.1", ">=1.5.2", ">1.5.2", "^1.5.1", ">=1.5.3garbage", ">=1.5.3-rc.1"]) {
      assert.throws(() => parsePluginManifest({ ...manifestV3(), engines: { nowen: range } }, { currentVersion: "1.5.3" }), /V3 插件必须/);
    }
    for (const range of [">=1.5.3", ">=1.5.3 <2.0.0", "^1.5.3", "~1.5.3", "1.5.3", ">=1.5.1 >=1.5.3"]) {
      assert.equal(parsePluginManifest({ ...manifestV3(), engines: { nowen: range } }, { currentVersion: "1.5.3" }).apiVersion, 3);
    }
    assert.equal(parsePluginManifest({ ...manifestV3(), engines: { nowen: ">=1.7.0" } }, { currentVersion: "1.7.0" }).apiVersion, 3);
  });
});

test("Host Bridge rejects completed request replays after the rate window expires", () => {
  const guard = new AppBridgeSessionGuardV3(session);
  const write = { ...request("write-once"), method: "action.execute" };
  guard.accept(write, 500_000);
  guard.complete(write.requestId);
  assert.throws(() => guard.accept(write, 561_000), /DUPLICATE_REQUEST/);
  guard.accept(request("another"), 561_000);
});

test("Host Bridge bounds replay history by revoking exhausted sessions without evicting old IDs", () => {
  const guard = new AppBridgeSessionGuardV3(session);
  for (let i = 0; i < APP_BRIDGE_V3_MAX_REQUESTS_PER_SESSION; i++) {
    const id = "r" + i;
    guard.accept(request(id), i * 1000);
    guard.complete(id);
  }
  const now = APP_BRIDGE_V3_MAX_REQUESTS_PER_SESSION * 1000;
  assert.throws(() => guard.accept(request("r0"), now), /DUPLICATE_REQUEST/);
  assert.throws(() => guard.accept(request("overflow"), now), /SESSION_EXHAUSTED/);
  assert.throws(() => guard.accept(request("new"), now), /SESSION_REVOKED/);
});
