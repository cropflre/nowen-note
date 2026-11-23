// 发布说明「更新方式」：和上一个正式版比较壳指纹，判断本版能不能通过热更新送达。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareReleases, describeShellChanges, renderUpdateMode } from "../hot-update/lib/update-mode.mjs";
import { computeRuntimeVersions } from "../hot-update/lib/fingerprint.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KEY = { id: "0123456789abcdef", createdAt: "2026-11-23", pem: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n" };
const NEW_KEY = { ...KEY, id: "fedcba9876543210", pem: "-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----\n" };

function memoryReader(files) {
  const blob = (content) => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
  return {
    list(prefix) {
      return Object.keys(files).filter((file) => file === prefix || file.startsWith(`${prefix}/`)).sort()
        .map((file) => ({ path: file, blob: blob(files[file]) }));
    },
    read(file) {
      if (!(file in files)) throw new Error(`missing ${file}`);
      return Buffer.from(files[file]);
    },
  };
}

/** 一个最小但完整的提交：壳指纹的全部输入都在。keys 为空表示还没有热更新能力。 */
function releaseTree({ keys = [KEY], patch = {} } = {}) {
  const tree = {
    "hot-update/config.json": JSON.stringify({ schema: 1, runtimeEpoch: { android: 1, desktop: 1 }, revokedBundleIds: { android: [], desktop: [] } }),
    "hot-update/public-keys.json": JSON.stringify({ schema: 1, keys }),
    "package.json": JSON.stringify({ version: "1.6.2", dependencies: { "electron-updater": "^6.3.9" }, devDependencies: { electron: "43.8.4" } }),
    "package-lock.json": JSON.stringify({ packages: { "node_modules/electron": { version: "43.8.4" }, "node_modules/electron-updater": { version: "6.3.9" } } }),
    "backend/build.bundle.mjs": 'const external = [\n  "better-sqlite3",\n  "sqlite-vec-windows-x64",\n];\n',
    "backend/package-lock.json": JSON.stringify({ packages: { "node_modules/better-sqlite3": { version: "12.0.0" } } }),
    "electron/main-bootstrap.js": "require('./main.js');",
    "electron/hot-update/loader.js": "loader",
    "electron/main.js": "console.log('main');",
    "electron/clipper-host.js": "host",
    "electron/clipper-native-host.js": "native host",
    "frontend/capacitor.config.ts": "export default { appId: 'com.nowen.note' };",
    "frontend/package-lock.json": JSON.stringify({
      packages: { "node_modules/@capacitor/android": { version: "8.4.3" }, "node_modules/@capacitor/core": { version: "8.4.3" }, "node_modules/@capacitor/app": { version: "8.0.1" } },
    }),
    "frontend/src/App.tsx": "export {};",
    "frontend/android/capacitor.settings.gradle":
      "include ':capacitor-android'\nproject(':capacitor-android').projectDir = new File('../node_modules/@capacitor/android/capacitor')\n" +
      "include ':capacitor-app'\nproject(':capacitor-app').projectDir = new File('../node_modules/@capacitor/app/android')\n",
    "frontend/android/app/build.gradle": "android {\n    defaultConfig {\n        versionCode 10602\n        versionName \"1.6.2\"\n    }\n}\n",
    "frontend/android/app/src/main/java/com/nowen/note/MainActivity.java": "class MainActivity {}",
    ...patch,
  };
  for (const [file, value] of Object.entries(patch)) if (value === undefined) delete tree[file];
  return tree;
}
const release = (options) => memoryReader(releaseTree(options));

const modes = (result) => ({ android: result.android.mode, desktop: result.desktop.mode });

test("只改前端、后端和主进程时两端都能热更新送达，发布说明一句话说清", () => {
  const previous = release();
  const current = release({ patch: { "frontend/src/App.tsx": "export const next = 1;", "electron/main.js": "console.log('main 2');" } });
  const result = compareReleases(previous, current);
  assert.deepEqual(modes(result), { android: "hot", desktop: "hot" });
  assert.equal(result.desktop.runtime, result.desktop.previousRuntime);
  assert.equal(
    renderUpdateMode(result, { previousVersion: "1.6.1" }),
    "> **更新方式：** 安卓和电脑客户端（Windows、macOS、Linux）：已经是 v1.6.1 的用户会在应用内自动收到本版，重启应用后生效。Microsoft Store 版、iOS 和 Docker 等服务端的更新方式不变。\n",
  );
});

test("升级 Electron 只让电脑客户端需要新安装包，安卓照常热更新，原因写进发布说明", () => {
  const previous = release();
  const current = release({
    patch: {
      "package.json": JSON.stringify({ version: "1.6.3", dependencies: { "electron-updater": "^6.3.9" }, devDependencies: { electron: "44.0.0" } }),
      "package-lock.json": JSON.stringify({ packages: { "node_modules/electron": { version: "44.0.0" }, "node_modules/electron-updater": { version: "6.3.9" } } }),
    },
  });
  const result = compareReleases(previous, current);
  assert.deepEqual(modes(result), { android: "hot", desktop: "full" });
  assert.deepEqual(result.desktop.reasons, ["electron 43.8.4 → 44.0.0"]);
  const notes = renderUpdateMode(result, { previousVersion: "1.6.2" });
  assert.match(notes, /^> \*\*更新方式：\*\*\n> - 安卓：已经是 v1\.6\.2 的用户会在应用内自动收到本版/);
  assert.match(notes, /> - 电脑客户端（Windows、macOS、Linux）：需要下载安装新版安装包（electron 43\.8\.4 → 44\.0\.0）。/);
});

test("壳的各类变化都翻译成看得懂的原因", () => {
  const previous = release();
  const android = compareReleases(previous, release({
    patch: {
      "frontend/android/app/src/main/java/com/nowen/note/MainActivity.java": "class MainActivity { void x() {} }",
      "frontend/package-lock.json": JSON.stringify({
        packages: { "node_modules/@capacitor/android": { version: "8.4.3" }, "node_modules/@capacitor/core": { version: "8.4.3" }, "node_modules/@capacitor/app": { version: "8.1.0" } },
      }),
    },
  }));
  assert.deepEqual(modes(android), { android: "full", desktop: "hot" });
  assert.deepEqual(android.android.reasons, ["安卓原生代码有更新", "@capacitor/app 8.0.1 → 8.1.0"]);

  const desktop = compareReleases(previous, release({
    patch: {
      "electron/hot-update/loader.js": "loader v2",
      "electron/clipper-host.js": "host v2",
      "backend/package-lock.json": JSON.stringify({ packages: { "node_modules/better-sqlite3": { version: "12.1.0" }, "node_modules/sqlite-vec-windows-x64": { version: "0.1.6" } } }),
    },
  }));
  assert.deepEqual(desktop.desktop.reasons, ["剪藏插件的本机组件有更新", "桌面启动器和热更新加载器有更新", "better-sqlite3 12.0.0 → 12.1.0", "新增 sqlite-vec-windows-x64 0.1.6"]);

  const epoch = computeRuntimeVersions(release({
    patch: { "hot-update/config.json": JSON.stringify({ schema: 1, runtimeEpoch: { android: 1, desktop: 2 }, revokedBundleIds: { android: [], desktop: [] } }) },
  }));
  const base = computeRuntimeVersions(previous);
  assert.deepEqual(describeShellChanges("desktop", base.inputs.desktop, epoch.inputs.desktop), ["安装包结构有调整"]);
});

test("换钥后两端都需要新安装包", () => {
  const result = compareReleases(release(), release({ keys: [NEW_KEY, KEY] }));
  assert.deepEqual(modes(result), { android: "full", desktop: "full" });
  assert.deepEqual(result.android.reasons, ["热更新签名公钥有变化"]);
  assert.deepEqual(result.desktop.reasons, ["热更新签名公钥有变化"]);
});

test("上一个版本没有热更新能力：本版是第一个带热更新能力的安装包", () => {
  // 上一个正式版连 hot-update/ 目录都没有，也照样能判断。
  const previous = release({ patch: { "hot-update/config.json": undefined, "hot-update/public-keys.json": undefined, "electron/hot-update/loader.js": undefined } });
  const result = compareReleases(previous, release());
  assert.deepEqual(modes(result), { android: "first", desktop: "first" });
  assert.match(renderUpdateMode(result, { previousVersion: "1.6.1" }), /本版是第一个支持热更新的版本，需要下载安装一次/);
  assert.deepEqual(modes(compareReleases(release({ keys: [] }), release())), { android: "first", desktop: "first" });
});

test("本次提交没有公钥：安装包不接受热更新，发布说明只写下载安装", () => {
  const result = compareReleases(release(), release({ keys: [] }));
  assert.deepEqual(modes(result), { android: "unavailable", desktop: "unavailable" });
  assert.match(renderUpdateMode(result, { previousVersion: "1.6.1" }), /安卓和电脑客户端（Windows、macOS、Linux）：需要下载安装新版安装包。/);
});

test("命令行按 git 提交比较；公钥为空时在 stderr 提醒维护者", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-update-mode-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  const write = (tree) => {
    for (const [file, content] of Object.entries(tree)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), content);
    }
  };
  write(releaseTree({ keys: [] }));
  git("add", "-A");
  git("commit", "-qm", "v1.6.1");
  git("tag", "v1.6.1");
  const cli = path.join(repoRoot, "scripts/hot-update/update-mode.mjs");
  const run = (...args) => spawnSync(process.execPath, [cli, "--repo", repo, ...args], { encoding: "utf8" });
  const noKey = run("--since", "v1.6.1");
  assert.equal(noKey.status, 0);
  assert.match(noKey.stderr, /没有公钥，这个提交打出的安装包不接受任何热更新/);
  assert.match(noKey.stdout, /需要下载安装新版安装包/);

  write(releaseTree());
  git("add", "-A");
  git("commit", "-qm", "add key");
  const first = run("--since", "v1.6.1", "--json");
  assert.equal(first.stderr, "");
  assert.equal(JSON.parse(first.stdout).desktop.mode, "first");
  assert.match(run("--ref", "HEAD").stderr, /需要 --since/);
});
