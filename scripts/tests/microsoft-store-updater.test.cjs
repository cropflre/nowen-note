"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const updaterCode = fs.readFileSync(path.join(root, "electron/updater.js"), "utf8");
const storeCode = fs.readFileSync(path.join(root, "electron/storeChannel.js"), "utf8");

function createRuntime({ windowsStore, portable = false }) {
  const handles = new Map();
  const urls = [];
  let updaterCalls = 0;
  const fakeProcess = {
    platform: "win32", arch: "x64", windowsStore,
    env: portable ? { PORTABLE_EXECUTABLE_FILE: "Nowen-Note-portable.exe" } : {},
  };
  const channelModule = { exports: {} };
  vm.runInNewContext(storeCode, { module: channelModule, process: fakeProcess });
  const fakeUpdater = {
    on() { updaterCalls++; },
    checkForUpdates() { updaterCalls++; return Promise.resolve({ updateInfo: { version: "1.5.3" } }); },
    quitAndInstall() { updaterCalls++; },
  };
  const electron = {
    app: { isPackaged: true, getVersion: () => "1.5.2", getPath: () => "C:\\test\\nowen", on() {} },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: {
      removeHandler(name) { handles.delete(name); },
      handle(name, callback) { handles.set(name, callback); },
    },
    dialog: { showMessageBox: async () => {} },
    shell: { openExternal: async uri => { urls.push(uri); } },
  };
  const m = { exports: {} };
  vm.runInNewContext(updaterCode, {
    module: m,
    exports: m.exports,
    process: fakeProcess,
    require(name) {
      if (name === "electron") return electron;
      if (name === "electron-updater") return { autoUpdater: fakeUpdater };
      if (name === "./storeChannel") return channelModule.exports;
      if (name === "./updaterPolicy") return require(path.join(root, "electron/updaterPolicy.js"));
      return require(name);
    },
    console: { warn() {}, log() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
  }, { filename: "electron/updater.js" });
  m.exports.initAutoUpdater();
  return {
    handles,
    urls,
    getUpdaterCalls: () => updaterCalls,
    check: () => handles.get("updater:check")(),
    install: () => handles.get("updater:quit-and-install")(),
    store: () => handles.get("updater:open-store")(),
  };
}

test("Store package never checks GitHub or invokes NSIS installer", async () => {
  const runtime = createRuntime({ windowsStore: true });
  assert.equal(runtime.getUpdaterCalls(), 0);
  const checked = await runtime.check();
  assert.equal(checked.ok, true);
  assert.equal(checked.managedBy, "microsoft-store");
  assert.equal(checked.state.status, "store-managed");
  assert.equal(checked.state.phase, "store-managed");
  assert.equal(checked.state.installOnQuit, false);
  const install = await runtime.install();
  assert.equal(install.ok, false);
  assert.equal(install.reason, "microsoft-store-managed");
  assert.equal(runtime.getUpdaterCalls(), 0);
  assert.equal(runtime.urls.length, 0);
  const open = await runtime.store();
  assert.equal(open.ok, true);
  assert.deepEqual(runtime.urls, ["ms-windows-store://downloadsandupdates"]);
});

test("Direct Windows installer remains on its previous updater policy", async () => {
  const runtime = createRuntime({ windowsStore: false });
  assert.ok(runtime.getUpdaterCalls() > 0);
  const store = await runtime.store();
  assert.equal(store.ok, false);
  assert.equal(store.reason, "not-store-build");
  assert.deepEqual(runtime.urls, []);
});

test("Portable Windows variant still blocks desktop auto-updater", async () => {
  const runtime = createRuntime({ windowsStore: false, portable: true });
  const state = await runtime.check();
  assert.equal(state.ok, false);
  assert.equal(state.reason, "portable-build");
  assert.equal(runtime.getUpdaterCalls(), 0);
});
