"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
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

test("AppX uses Nowen tile assets without electron-builder sample fallback", async () => {
  require("app-builder-lib");
  const AppXTarget = require("app-builder-lib/out/targets/AppxTarget").default;
  const assetsDir = path.join(repoRoot, "build/appx");
  const sizes = {
    "StoreLogo.png": [50, 50],
    "Square150x150Logo.png": [150, 150],
    "Square44x44Logo.png": [44, 44],
    "Wide310x150Logo.png": [310, 150],
  };
  const assets = await AppXTarget.computeUserAssets(
    { toVmFile: file => file, pathSep: path.sep },
    path.join(repoRoot, "unused-vendor-assets"),
    fs.existsSync(assetsDir) ? assetsDir : null,
  );
  assert.deepEqual(assets.userAssets.sort(), Object.keys(sizes).sort());
  assert.equal(assets.allAssets.length, Object.keys(sizes).length);
  for (const file of assets.allAssets) {
    assert.equal(path.dirname(file), assetsDir, "sample AppX asset must never be used");
    const png = fs.readFileSync(file);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], sizes[path.basename(file)]);
  }
});
