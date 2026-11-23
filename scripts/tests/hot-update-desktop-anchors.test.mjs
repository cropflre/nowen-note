// 桌面安装包里的热更新信任锚点核对（CI 在 electron-builder 之后运行）。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gitTreeReader } from "../hot-update/lib/fingerprint.mjs";
import { checkDesktopAnchors, expectedDesktopAnchors, findAppArchives, verifyDesktopAnchors } from "../hot-update/verify-desktop-anchors.mjs";

const require = createRequire(import.meta.url);
const { createPackage } = require("@electron/asar");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const expected = { runtimeVersion: "e1-0123456789abcdef", publicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n", keyId: "0123456789abcdef" };

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function packApp(t, dist, relative, nowenHotUpdate) {
  const source = tempDir(t, "nowen-asar-src-");
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "nowen-note", version: "1.6.2", main: "electron/main-bootstrap.js", ...(nowenHotUpdate ? { nowenHotUpdate } : {}) }));
  fs.mkdirSync(path.join(source, "electron"));
  fs.writeFileSync(path.join(source, "electron", "main-bootstrap.js"), "");
  const target = path.join(dist, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await createPackage(source, target);
}

const LAYOUT = ["win-unpacked/resources/app.asar", "mac/Nowen Note.app/Contents/Resources/app.asar", "mac-arm64/Nowen Note.app/Contents/Resources/app.asar"];

test("Windows、macOS 双架构的 app.asar 都被找到并核对通过；不进入 .asar.unpacked 和符号链接", async (t) => {
  const dist = tempDir(t, "nowen-dist-");
  for (const relative of LAYOUT) await packApp(t, dist, relative, expected);
  // 这两处即使放了 app.asar 也不是应用本体。
  await packApp(t, dist, "mac-arm64/Nowen Note.app/Contents/Resources/app.asar.unpacked/app.asar", { ...expected, keyId: "wrong" });
  fs.symlinkSync(path.join(dist, "mac"), path.join(dist, "mac-link"), "dir");
  const archives = await verifyDesktopAnchors({ dist, expected });
  assert.deepEqual(archives.map((file) => path.relative(dist, file).split(path.sep).join("/")), [...LAYOUT].sort());
});

test("任何一个 app.asar 的壳指纹、公钥不符或缺少锚点都会失败，并指出是哪个文件", async (t) => {
  for (const [anchors, message] of [
    [{ ...expected, runtimeVersion: "e1-ffffffffffffffff" }, /mac-arm64.*热更新壳指纹与源码提交不一致/],
    [{ ...expected, publicKey: "", keyId: "" }, /mac-arm64.*热更新公钥与源码提交不一致/],
    [null, /mac-arm64.*没有 nowenHotUpdate/],
  ]) {
    const dist = tempDir(t, "nowen-dist-bad-");
    await packApp(t, dist, LAYOUT[0], expected);
    await packApp(t, dist, LAYOUT[2], anchors);
    await assert.rejects(verifyDesktopAnchors({ dist, expected }), message);
  }
  await assert.rejects(verifyDesktopAnchors({ dist: tempDir(t, "nowen-dist-empty-"), expected }), /没有打包好的 app\.asar/);
  assert.deepEqual(await findAppArchives(tempDir(t, "nowen-dist-none-")), []);
});

test("没有公钥的提交：期望的锚点是空公钥，核对仍要求安装包与之一致", () => {
  assert.doesNotThrow(() => checkDesktopAnchors({ nowenHotUpdate: { runtimeVersion: "e1-0123456789abcdef", publicKey: "", keyId: "" } }, { ...expected, publicKey: "", keyId: "" }));
  assert.throws(() => checkDesktopAnchors({ nowenHotUpdate: expected }, { ...expected, publicKey: "", keyId: "" }), /公钥/);
});

test("打包配置写进安装包的锚点，正是核对脚本按源码算出的期望值", () => {
  const config = require(path.join(repoRoot, "electron", "builder.base.config.js"));
  assert.deepEqual(config.extraMetadata.nowenHotUpdate, expectedDesktopAnchors(gitTreeReader(repoRoot)));
});
