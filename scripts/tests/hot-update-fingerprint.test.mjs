import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  computeRuntimeVersions,
  gitTreeReader,
  normalizeAndroidAppGradle,
  parseBackendExternals,
  parseCapacitorPluginPackages,
} from "../hot-update/lib/fingerprint.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function memoryReader(files) {
  const blob = (content) => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
  return {
    list(prefix) {
      return Object.keys(files)
        .filter((file) => file === prefix || file.startsWith(`${prefix}/`))
        .sort()
        .map((file) => ({ path: file, blob: blob(files[file]) }));
    },
    read(file) {
      if (!(file in files)) throw new Error(`missing ${file}`);
      return Buffer.from(files[file]);
    },
  };
}

function baseTree() {
  return {
    "hot-update/config.json": JSON.stringify({ schema: 1, runtimeEpoch: { android: 1, desktop: 1 }, revokedBundleIds: { android: [], desktop: [] } }),
    "hot-update/public-keys.json": JSON.stringify({ schema: 1, keys: [] }),
    "package.json": JSON.stringify({ version: "1.6.2", dependencies: { "electron-updater": "^6.3.9" }, devDependencies: { electron: "43.8.4" } }),
    "package-lock.json": JSON.stringify({ packages: { "node_modules/electron": { version: "43.8.4" }, "node_modules/electron-updater": { version: "6.3.9" } } }),
    "backend/build.bundle.mjs": 'const external = [\n  "better-sqlite3",\n  // 注释里的 "quoted" 不算\n  "sharp",\n  "sqlite-vec-windows-x64",\n];\n',
    "backend/package-lock.json": JSON.stringify({ packages: { "node_modules/better-sqlite3": { version: "12.0.0" }, "node_modules/sharp": { version: "0.34.0" } } }),
    "backend/src/index.ts": "export {};",
    "electron/main-bootstrap.js": "require('./main.js');",
    "electron/main.js": "console.log('main');",
    "electron/clipper-host.js": "host",
    "electron/clipper-native-host.js": "native host",
    "electron/builder.base.config.js": "module.exports = {};",
    "frontend/capacitor.config.ts": "export default { appId: 'com.nowen.note' };",
    "frontend/package-lock.json": JSON.stringify({
      packages: {
        "node_modules/@capacitor/android": { version: "8.4.3" },
        "node_modules/@capacitor/core": { version: "8.4.3" },
        "node_modules/@capacitor/app": { version: "8.0.1" },
      },
    }),
    "frontend/src/App.tsx": "export {};",
    "frontend/android/capacitor.settings.gradle":
      "include ':capacitor-android'\nproject(':capacitor-android').projectDir = new File('../node_modules/@capacitor/android/capacitor')\n" +
      "include ':capacitor-app'\nproject(':capacitor-app').projectDir = new File('../node_modules/@capacitor/app/android')\n",
    "frontend/android/app/build.gradle": "android {\n    defaultConfig {\n        versionCode 10600\n        versionName \"1.6.0\"\n        minSdkVersion 24\n    }\n}\n",
    "frontend/android/app/src/main/java/com/nowen/note/MainActivity.java": "class MainActivity {}",
    "frontend/android/app/src/test/java/com/nowen/note/SomeTest.java": "class SomeTest {}",
    "frontend/android/gradle/wrapper/gradle-wrapper.properties": "distributionUrl=gradle-8.zip",
  };
}

function runtimes(patch = {}) {
  const tree = { ...baseTree(), ...patch };
  for (const [file, value] of Object.entries(patch)) if (value === undefined) delete tree[file];
  const { android, desktop } = computeRuntimeVersions(memoryReader(tree));
  return { android, desktop };
}

test("runtimeVersion 带 epoch 前缀并且稳定", () => {
  const first = runtimes();
  assert.match(first.android, /^e1-[0-9a-f]{16}$/);
  assert.match(first.desktop, /^e1-[0-9a-f]{16}$/);
  assert.deepEqual(runtimes(), first);
});

test("只改版本号、前端、后端源码、主进程或打包配置时，壳指纹不变", () => {
  const base = runtimes();
  const same = [
    { "frontend/android/app/build.gradle": baseTree()["frontend/android/app/build.gradle"].replace("10600", "10601").replace('"1.6.0"', '"1.6.1"') },
    { "package.json": JSON.stringify({ version: "1.6.3", dependencies: { "electron-updater": "^6.3.9" }, devDependencies: { electron: "43.8.4" } }) },
    { "frontend/src/App.tsx": "export const changed = true;" },
    { "backend/src/index.ts": "export const changed = true;" },
    { "electron/main.js": "console.log('changed');" },
    { "electron/builder.base.config.js": "module.exports = { changed: true };" },
    { "frontend/android/app/src/test/java/com/nowen/note/SomeTest.java": "class SomeTest { int x; }" },
    { "frontend/android/gradle/wrapper/gradle-wrapper.properties": "distributionUrl=gradle-9.zip" },
    { "frontend/android/app/src/main/assets/public/index.html": "<html>" },
  ];
  for (const patch of same) assert.deepEqual(runtimes(patch), base, Object.keys(patch)[0]);
});

test("安卓原生代码、插件版本、Capacitor 配置、Gradle 配置变化时，安卓指纹改变", () => {
  const base = runtimes();
  const lock = JSON.parse(baseTree()["frontend/package-lock.json"]);
  lock.packages["node_modules/@capacitor/app"].version = "8.0.2";
  const changes = [
    { "frontend/android/app/src/main/java/com/nowen/note/MainActivity.java": "class MainActivity { void x() {} }" },
    { "frontend/package-lock.json": JSON.stringify(lock) },
    { "frontend/capacitor.config.ts": "export default { appId: 'com.nowen.note', plugins: {} };" },
    { "frontend/android/app/build.gradle": baseTree()["frontend/android/app/build.gradle"].replace("minSdkVersion 24", "minSdkVersion 26") },
    { "frontend/android/app/src/main/AndroidManifest.xml": "<manifest/>" },
  ];
  for (const patch of changes) {
    const next = runtimes(patch);
    assert.notEqual(next.android, base.android, Object.keys(patch)[0]);
    assert.equal(next.desktop, base.desktop, Object.keys(patch)[0]);
  }
});

test("Electron、生产依赖、后端原生依赖、壳文件变化时，桌面指纹改变", () => {
  const base = runtimes();
  const rootLock = JSON.parse(baseTree()["package-lock.json"]);
  rootLock.packages["node_modules/electron"].version = "43.9.0";
  const backendLock = JSON.parse(baseTree()["backend/package-lock.json"]);
  backendLock.packages["node_modules/sharp"].version = "0.35.0";
  const changes = [
    { "package-lock.json": JSON.stringify(rootLock) },
    { "backend/package-lock.json": JSON.stringify(backendLock) },
    { "backend/build.bundle.mjs": baseTree()["backend/build.bundle.mjs"].replace('"sharp",', '"sharp",\n  "canvas",') },
    { "electron/main-bootstrap.js": "require('./hot-update/loader.js');" },
    { "electron/hot-update/loader.js": "module.exports = {};" },
    { "electron/clipper-native-host.js": "native host v2" },
  ];
  for (const patch of changes) {
    const next = runtimes(patch);
    assert.notEqual(next.desktop, base.desktop, Object.keys(patch)[0]);
    assert.equal(next.android, base.android, Object.keys(patch)[0]);
  }
});

test("公钥列表和 runtimeEpoch 变化时两端都改变", () => {
  const base = runtimes();
  const keys = runtimes({ "hot-update/public-keys.json": JSON.stringify({ schema: 1, keys: [{ id: "x" }] }) });
  assert.notEqual(keys.android, base.android);
  assert.notEqual(keys.desktop, base.desktop);
  const epoch = runtimes({ "hot-update/config.json": JSON.stringify({ schema: 1, runtimeEpoch: { android: 2, desktop: 1 }, revokedBundleIds: { android: [], desktop: [] } }) });
  assert.match(epoch.android, /^e2-/);
  assert.equal(epoch.desktop, base.desktop);
});

test("缺少必需输入或配置无效时直接报错", () => {
  assert.throws(() => runtimes({ "backend/build.bundle.mjs": "export default {};" }), /external/);
  assert.throws(() => runtimes({ "electron/main-bootstrap.js": undefined }), /main-bootstrap/);
  assert.throws(() => runtimes({ "hot-update/config.json": JSON.stringify({ schema: 1, runtimeEpoch: { android: 0, desktop: 1 } }) }), /runtimeEpoch/);
  const lock = JSON.parse(baseTree()["frontend/package-lock.json"]);
  delete lock.packages["node_modules/@capacitor/app"];
  assert.throws(() => runtimes({ "frontend/package-lock.json": JSON.stringify(lock) }), /@capacitor\/app/);
});

test("解析工具对真实文件格式有效", () => {
  assert.equal(normalizeAndroidAppGradle("a\n        versionCode 10511\n        versionName \"1.5.5\"\nb\n"), "a\nb\n");
  assert.deepEqual(parseCapacitorPluginPackages(baseTree()["frontend/android/capacitor.settings.gradle"]), ["@capacitor/android", "@capacitor/app"]);
  assert.deepEqual(parseBackendExternals(baseTree()["backend/build.bundle.mjs"]), ["better-sqlite3", "sharp", "sqlite-vec-windows-x64"]);
});

test("仓库当前提交能算出两端的 runtimeVersion", (t) => {
  const tracked = execFileSync("git", ["-C", repoRoot, "ls-tree", "--name-only", "HEAD", "hot-update/config.json"], { encoding: "utf8" }).trim();
  if (!tracked) return t.skip("hot-update/config.json 还没有提交");
  const result = computeRuntimeVersions(gitTreeReader(repoRoot));
  assert.match(result.android, /^e\d+-[0-9a-f]{16}$/);
  assert.match(result.desktop, /^e\d+-[0-9a-f]{16}$/);
  // 真实仓库的 external 名单必须能解析，且包含 better-sqlite3
  assert.ok(result.inputs.desktop.packages.backendExternal.some(([name]) => name === "better-sqlite3"));
  assert.ok(result.inputs.android.packages.some(([name]) => name === "@capacitor/android"));
});
