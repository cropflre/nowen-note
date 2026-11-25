"use strict";
// 热更新已经运行到某个版本时，整包更新检查不应再提示下载同一版本（app.getVersion() 只是壳的版本）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const updaterCode = fs.readFileSync(path.join(root, "electron/updater.js"), "utf8");

function createRuntime(hotUpdate) {
  const handlers = new Map();
  const sent = [];
  const fakeUpdater = {
    on(event, handler) { handlers.set(event, handler); },
    checkForUpdates: async () => ({ updateInfo: { version: "1.6.3" } }),
    quitAndInstall() {},
  };
  const electron = {
    app: { isPackaged: true, getVersion: () => "1.6.2", getPath: () => "/tmp/nowen", on() {} },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } }] },
    ipcMain: { removeHandler() {}, handle() {} },
    dialog: { showMessageBox: async () => {} },
    shell: { openExternal: async () => {} },
  };
  const m = { exports: {} };
  vm.runInNewContext(updaterCode, {
    module: m,
    exports: m.exports,
    // Linux AppImage：应用内自动更新的平台，避免走手动下载分支
    process: { platform: "linux", arch: "x64", env: { APPIMAGE: "/tmp/Nowen.AppImage" } },
    require(name) {
      if (name === "electron") return electron;
      if (name === "electron-updater") return { autoUpdater: fakeUpdater };
      if (name === "./updaterPolicy") return require(path.join(root, "electron/updaterPolicy.js"));
      if (name === "./storeChannel") return require(path.join(root, "electron/storeChannel.js"));
      if (name === "./db-backup") return require(path.join(root, "electron/db-backup.js"));
      return require(name);
    },
    console: { warn() {}, log() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    __nowenHotUpdate: hotUpdate,
  }, { filename: "electron/updater.js" });
  m.exports.initAutoUpdater();
  return {
    available: (version) => handlers.get("update-available")({ version, files: [] }),
    lastStatus: () => sent.filter((item) => item.channel === "updater:status").at(-1)?.payload,
  };
}

test("热更新已运行到发布的版本：整包检查报告已是最新，不提示下载", () => {
  const runtime = createRuntime({ covers: (version) => version === "1.6.3", effectiveVersion: "1.6.3" });
  runtime.available("1.6.3");
  const status = runtime.lastStatus();
  assert.equal(status.phase, "up-to-date");
  assert.match(status.message, /已通过热更新升级到 v1\.6\.3/);
});

test("新版本改了壳（热更新覆盖不到）：照常提示整包更新", () => {
  const runtime = createRuntime({ covers: () => false, effectiveVersion: "1.6.3" });
  runtime.available("1.7.0");
  assert.equal(runtime.lastStatus().phase, "update-available");
});

test("没有热更新加载器（旧壳）时行为不变", () => {
  const runtime = createRuntime(undefined);
  runtime.available("1.6.3");
  assert.equal(runtime.lastStatus().phase, "update-available");
});
