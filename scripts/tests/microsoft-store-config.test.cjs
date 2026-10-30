"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const repoRoot = path.resolve(__dirname, "../..");
const configPath = path.join(repoRoot, "electron", "builder.store.config.js");
const runtime = require(path.join(repoRoot, "electron", "storeChannel.js"));
const identity = {
  NOWEN_STORE_IDENTITY_NAME: "Nowen.NowenNote",
  NOWEN_STORE_PUBLISHER: "CN=74C7CC89-20E0-4BEA-AD68-6A3238278EF3",
  NOWEN_STORE_PUBLISHER_DISPLAY_NAME: "Nowen",
};

function readStoreConfig(env = {}) {
  return spawnSync(process.execPath, ["-e",
    "const c=require(process.argv[1]);process.stdout.write(JSON.stringify({publish:c.publish,output:c.directories.output,win:c.win,appx:c.appx}));",
    configPath,
  ], {
    cwd: repoRoot,
    env: { ...process.env, NOWEN_STORE_IDENTITY_NAME: "", NOWEN_STORE_PUBLISHER: "",
      NOWEN_STORE_PUBLISHER_DISPLAY_NAME: "", ...env },
    encoding: "utf8",
  });
}

test("Verified Partner Center identity is available without GitHub Variables", () => {
  const result = readStoreConfig();
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.appx.identityName, identity.NOWEN_STORE_IDENTITY_NAME);
  assert.equal(config.appx.publisher, identity.NOWEN_STORE_PUBLISHER);
  assert.equal(config.appx.publisherDisplayName, "Nowen");
  assert.equal(require(path.join(repoRoot, "electron/storeIdentity.js")).STORE_IDENTITY.storeId, "9MZ7Z6S39LL3");
});

test("An incorrect variable override must fail closed", () => {
  assert.notEqual(readStoreConfig({ ...identity, NOWEN_STORE_PUBLISHER: "CN=ms" }).status, 0);
  assert.notEqual(readStoreConfig({ ...identity, NOWEN_STORE_IDENTITY_NAME: "../../fake" }).status, 0);
  assert.notEqual(readStoreConfig({ ...identity, NOWEN_STORE_APPLICATION_ID: "OtherApp" }).status, 0);
});

test("Store-only target is AppX; never uploads NSIS or publishes to GitHub", () => {
  const r = readStoreConfig(identity);
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  assert.equal(c.publish, null);
  assert.equal(c.output, "dist-electron-store");
  assert.deepEqual(c.win.target, [{ target: "appx", arch: ["x64"] }]);
  assert.equal(c.win.artifactName, "Nowen-Note-Store-\x24{version}-\x24{arch}.\x24{ext}");
  assert.equal(c.appx.identityName, identity.NOWEN_STORE_IDENTITY_NAME);
  assert.equal(c.appx.publisher, identity.NOWEN_STORE_PUBLISHER);
  // The pinned electron-builder 25.1.8 AppXOptions schema rejects "capabilities".
  // The mandatory runFullTrust entry is emitted by its AppX generator, and the
  // actual generated manifest is checked in the Windows packaging workflow.
  assert.equal(Object.hasOwn(c.appx, "capabilities"), false);
  const supportedAppXKeys = new Set([
    "addAutoLaunchExtension", "applicationId", "artifactName", "backgroundColor",
    "customExtensionsPath", "displayName", "electronUpdaterAware", "identityName",
    "languages", "makeappxArgs", "maxVersionTested", "minVersion",
    "publish", "publisher", "publisherDisplayName", "setBuildNumber",
    "showNameOnTiles",
  ]);
  assert.deepEqual(Object.keys(c.appx).filter(key => !supportedAppXKeys.has(key)), []);
  assert.equal(c.appx.applicationId, "NowenNote");
});

test("Store runtime is detected by real Electron process.windowsStore, never by env spoofing", () => {
  assert.equal(runtime.isMicrosoftStorePackage({ platform: "win32", packaged: true, windowsStore: true }), true);
  assert.equal(runtime.isMicrosoftStorePackage({ platform: "win32", packaged: true, windowsStore: false }), false);
  assert.equal(runtime.isMicrosoftStorePackage({ platform: "linux", packaged: true, windowsStore: true }), false);
  assert.equal(runtime.isMicrosoftStorePackage({ platform: "win32", packaged: false, windowsStore: true }), false);
  assert.equal(runtime.STORE_UPDATES_URI, "ms-windows-store://downloadsandupdates");
  const snapshot = runtime.storeManagedSnapshot("1.5.2", "x64");
  assert.equal(snapshot.phase, "store-managed");
  assert.equal(snapshot.installOnQuit, false);
});

test("existing NSIS Full/Lite builder targets are unchanged", () => {
  const full = require(path.join(repoRoot, "electron", "builder.config.js"));
  const lite = require(path.join(repoRoot, "electron", "builder.lite.config.js"));
  assert.ok(full.win.target.some(t => t.target === "nsis"));
  assert.ok(full.win.target.some(t => t.target === "portable"));
  assert.ok(lite.win.target.some(t => t.target === "nsis"));
  assert.equal(full.directories.output, "dist-electron");
});
