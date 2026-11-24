// 桌面热更新加载器（壳代码，永不热更新），由 main-bootstrap.js 在加载主进程代码之前调用。
//
// 信任锚点（壳指纹、公钥）在打包时写进 app.asar 里 package.json 的 nowenHotUpdate 字段，
// 热更新包改不到。加载器本身出任何错，都只会退回安装包自带的版本，绝不阻断启动。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { createHotUpdateRuntime } = require("./runtime");

const PRODUCTION_CHANNEL = {
  urls: (runtimeVersion) => [
    `https://download.nowen.cn/hot/stable/desktop/${runtimeVersion}.json`,
    `https://github.com/cropflre/nowen-note/releases/latest/download/nowen-hot-desktop-${runtimeVersion}.json`,
  ],
  allowedOrigins: ["https://download.nowen.cn", "https://github.com"],
};

function readConfig({ app, shellDir }) {
  const { isMicrosoftStorePackage } = require(path.join(shellDir, "storeChannel"));
  if (isMicrosoftStorePackage({ packaged: app.isPackaged })) return { disabledReason: "microsoft-store-managed" };
  let source = null;
  let channel = PRODUCTION_CHANNEL;
  let readyTimeoutMs;
  if (app.isPackaged) {
    source = JSON.parse(fs.readFileSync(path.join(shellDir, "..", "package.json"), "utf8")).nowenHotUpdate || null;
  } else if (process.env.NOWEN_HOT_UPDATE_TEST_ANCHORS) {
    // 只在未打包的开发构建里生效，供本机验收使用；正式安装包永远读 package.json。
    source = JSON.parse(fs.readFileSync(process.env.NOWEN_HOT_UPDATE_TEST_ANCHORS, "utf8"));
    const origin = new URL(source.channelOrigin).origin;
    channel = { urls: (runtimeVersion) => [`${origin}/hot/stable/desktop/${runtimeVersion}.json`], allowedOrigins: [origin] };
    readyTimeoutMs = Number(source.readyTimeoutMs) || undefined;
  } else {
    return { disabledReason: "development-build" };
  }
  if (!source?.runtimeVersion) return { disabledReason: "no-runtime" };
  if (!source.publicKey || !source.keyId) return { disabledReason: "no-public-key", anchors: { runtimeVersion: source.runtimeVersion } };
  return {
    anchors: { runtimeVersion: source.runtimeVersion, publicKeyPem: source.publicKey, keyId: source.keyId },
    channel,
    readyTimeoutMs,
  };
}

/**
 * 让热更新包里的主进程代码解析安装包里的生产依赖（目前只有 electron-updater）。
 * Module.globalPaths 只是 Node 启动时留的副本，改它不影响解析；Electron 自己也是包装
 * _nodeModulePaths 来调整查找路径。这里只给包内 electron 目录下的文件，在最前面加上安装包的 node_modules。
 */
function addBundleModulePaths(bundleElectronDir, modulesDir) {
  const original = Module._nodeModulePaths;
  const roots = [bundleElectronDir];
  try {
    roots.push(fs.realpathSync(bundleElectronDir));
  } catch {
    /* 目录不存在时只按原路径比较 */
  }
  const inside = (from) =>
    roots.some((root) => {
      const relative = path.relative(root, from);
      return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    });
  Module._nodeModulePaths = function nodeModulePaths(from) {
    const paths = original.call(this, from);
    return inside(from) ? [modulesDir, ...paths] : paths;
  };
  return () => {
    Module._nodeModulePaths = original;
  };
}

function bootstrapHotUpdate({ electron, shellDir }) {
  const { app } = electron;
  const base = {
    shellDir,
    stateDir: path.join(app.getPath("userData"), "hot-update"),
    shellVersion: app.getVersion(),
    channel: PRODUCTION_CHANNEL,
    // 后端的原生依赖（better-sqlite3、sharp 等）始终来自安装目录。
    backendModulesDir: app.isPackaged
      ? path.join(process.resourcesPath, "backend", "node_modules")
      : path.join(shellDir, "..", "backend", "node_modules"),
    fetch: (url) => electron.net.fetch(url, { cache: "no-store" }),
    relaunch: () => {
      app.relaunch();
      app.exit(0);
    },
    backupDatabase: ({ fromVersion, toVersion }) => {
      const { getUserDataPathFromRoot } = require(path.join(shellDir, "dataDir"));
      const { createPreUpdateBackup } = require(path.join(shellDir, "db-backup"));
      const target = createPreUpdateBackup({ dataDir: getUserDataPathFromRoot(app.getPath("userData")), fromVersion, toVersion, reason: "hot-update" });
      if (target) console.log("[hot-update] 新包首次启动前已备份数据库：", target);
    },
    log: (...args) => console.log(...args),
  };
  let runtime;
  try {
    const config = readConfig({ app, shellDir });
    runtime = createHotUpdateRuntime({ ...base, ...config, channel: config.channel || PRODUCTION_CHANNEL });
    runtime.selectBoot();
  } catch (error) {
    console.error("[hot-update] 加载器出错，本次使用安装包自带的版本：", error);
    runtime = createHotUpdateRuntime({ ...base, anchors: null, disabledReason: "loader-error" });
  }
  const api = runtime.api;
  if (runtime.bundle) addBundleModulePaths(path.join(runtime.bundle.root, "electron"), path.join(shellDir, "..", "node_modules"));
  global.__nowenHotUpdate = api;
  app.whenReady().then(() => api.startScheduler()).catch(() => undefined);
  return runtime;
}

module.exports = { PRODUCTION_CHANNEL, addBundleModulePaths, bootstrapHotUpdate, readConfig };
