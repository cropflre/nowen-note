// 桌面热更新壳：用发版流水线自己的库（scripts/hot-update/lib）造包和签名，验证状态机全流程。
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createZip } from "../../scripts/hot-update/lib/zip.mjs";
import { publicKeyId, signBytes, SIGNATURE_ALGORITHM, toPublicPem } from "../../scripts/hot-update/lib/keys.mjs";
import { encodeEnvelope, orderManifest, serializeManifest, sha256Hex } from "../../scripts/hot-update/lib/manifest.mjs";

const require = createRequire(import.meta.url);
const { readZip } = require("../hot-update/zip-reader.js");
const trust = require("../hot-update/trust.js");
const { createHotUpdateRuntime, ENVELOPE_FILE } = require("../hot-update/runtime.js");
const { addBundleModulePaths, readConfig } = require("../hot-update/loader.js");
const { createPreUpdateBackup } = require("../db-backup.js");

const RUNTIME = "e1-0123456789abcdef";
const ORIGIN = "https://download.nowen.cn";
const key = generateKeyPairSync("rsa", { modulusLength: 3072 });
const keyId = publicKeyId(key.publicKey);
const anchors = { runtimeVersion: RUNTIME, publicKeyPem: toPublicPem(key.publicKey), keyId };
const channel = { urls: (runtime) => [`${ORIGIN}/hot/stable/desktop/${runtime}.json`], allowedOrigins: [ORIGIN] };

function bundleFiles(version, extra = {}) {
  return {
    "electron/main.js": `console.log("main ${version}");\n`,
    "electron/preload.js": "// preload\n",
    "frontend/dist/index.html": `<title>${version}</title>`,
    "backend/dist/index.js": `console.log("backend ${version}");\n`,
    "backend/package.json": JSON.stringify({ name: "nowen-note-backend", version }),
    ...extra,
  };
}

/** 生成一个桌面热更新包：zip + 签名信封（与流水线 sign.mjs 相同的格式）。 */
function makeRelease(version, { sequence = 100, signer = key.privateKey, runtimeVersion = RUNTIME, files = bundleFiles(version), revoked = [], mutateManifest } = {}) {
  const entries = Object.entries(files).map(([file, content]) => ({ path: file, data: Buffer.from(content) }));
  const zip = createZip(entries);
  const sha256 = sha256Hex(zip);
  const manifest = orderManifest({
    schema: 1, target: "desktop", channel: "stable", version, runtimeVersion,
    bundleId: `${version}-${sha256.slice(0, 8)}`, sequence, commit: "c".repeat(40), createdAt: "2026-11-22T00:00:00.000Z",
    size: zip.length, sha256, zipSignature: signBytes(signer, zip),
    urls: [`${ORIGIN}/hot/v${version}/nowen-hot-desktop-${version}.zip`],
    files: Object.fromEntries(entries.map((entry) => [entry.path, sha256Hex(entry.data)]).sort(([a], [b]) => (a < b ? -1 : 1))),
    revokedBundleIds: revoked,
  });
  mutateManifest?.(manifest);
  const payload = serializeManifest(manifest);
  const envelope = encodeEnvelope(payload, [{ keyId: publicKeyId(signer), algorithm: SIGNATURE_ALGORITHM, signature: signBytes(signer, payload) }]);
  return { manifest, zip, envelope };
}

function harness(t, overrides = {}) {
  const stateDir = overrides.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "nowen-hot-desktop-"));
  if (!overrides.stateDir) t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const server = overrides.server ?? new Map();
  const events = { relaunches: 0, backups: [], timers: [], logs: [] };
  const fetch = async (url) => {
    const body = server.get(url.split("?")[0]);
    if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    if (typeof body === "number") return { ok: false, status: body, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  const runtime = createHotUpdateRuntime({
    shellDir: "/shell/electron",
    stateDir,
    shellVersion: overrides.shellVersion ?? "1.6.2",
    anchors: overrides.anchors ?? anchors,
    channel,
    backendModulesDir: overrides.backendModulesDir,
    disabledReason: overrides.disabledReason,
    fetch,
    relaunch: () => { events.relaunches += 1; },
    backupDatabase: (info) => events.backups.push(info),
    now: () => 1_800_000_000_000,
    setTimer: (callback, delay) => { const timer = { callback, delay, cleared: false }; events.timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
    log: (line) => events.logs.push(line),
  });
  return { runtime, api: runtime.api, stateDir, server, events };
}

function publish(server, release) {
  server.set(`${ORIGIN}/hot/stable/desktop/${release.manifest.runtimeVersion}.json`, release.envelope);
  server.set(release.manifest.urls[0], release.zip);
}

const readState = (stateDir) => JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));

test("与流水线互通：zip、签名信封都能被壳代码读出和验签", () => {
  const release = makeRelease("1.6.3");
  assert.deepEqual(readZip(release.zip).map((entry) => entry.path), Object.keys(release.manifest.files));
  const trusted = { key: trust.loadTrustedKey(anchors.publicKeyPem, keyId), keyId, allowedOrigins: [ORIGIN] };
  assert.equal(trust.openEnvelope(release.envelope, trusted).version, "1.6.3");
  const other = generateKeyPairSync("rsa", { modulusLength: 3072 });
  assert.throws(() => trust.openEnvelope(makeRelease("1.6.3", { signer: other.privateKey }).envelope, trusted), /没有安装包信任的签名/);
  const tampered = JSON.parse(release.envelope.toString());
  tampered.payload = Buffer.from(Buffer.from(tampered.payload, "base64").toString().replace("1.6.3", "1.6.9")).toString("base64");
  assert.throws(() => trust.openEnvelope(Buffer.from(JSON.stringify(tampered)), trusted), /签名校验失败/);
  assert.throws(() => trust.loadTrustedKey(anchors.publicKeyPem, "0000000000000000"), /keyId/);
});

test("检查到新版本：下载、校验、解压、暂存；重启后试运行，界面确认后成为可用版本", async (t) => {
  const first = harness(t);
  assert.equal(first.runtime.selectBoot(), null);
  const release = makeRelease("1.6.3");
  publish(first.server, release);
  const status = await first.api.check({ manual: true });
  assert.equal(status.phase, "ready");
  assert.deepEqual(status.pending, { bundleId: release.manifest.bundleId, version: "1.6.3" });
  const root = path.join(first.stateDir, "bundles", release.manifest.bundleId);
  assert.equal(fs.readFileSync(path.join(root, "frontend/dist/index.html"), "utf8"), "<title>1.6.3</title>");
  assert.ok(fs.existsSync(path.join(root, ENVELOPE_FILE)));
  assert.equal(first.api.apply(), true);
  assert.equal(first.events.relaunches, 1);

  // 重启：新包第一次启动，先备份数据库，主进程从包里加载，带试运行计时
  const second = harness(t, { stateDir: first.stateDir, server: first.server });
  assert.equal(second.runtime.selectBoot().bundleId, release.manifest.bundleId);
  assert.deepEqual(second.events.backups, [{ fromVersion: "1.6.2", toVersion: "1.6.3" }]);
  let loadedFrom = null;
  second.runtime.loadEntry((dir) => { loadedFrom = dir; });
  assert.equal(loadedFrom, path.join(root, "electron"));
  assert.equal(second.api.getStatus().trial, true);
  assert.equal(second.api.effectiveVersion, "1.6.3");
  assert.equal(second.events.timers.length, 1);
  second.api.markReady();
  assert.equal(second.events.timers[0].cleared, true);
  assert.deepEqual(readState(first.stateDir).active, { bundleId: release.manifest.bundleId, version: "1.6.3" });

  // 之后的启动直接使用已确认的包，不再试运行、不再备份
  const third = harness(t, { stateDir: first.stateDir, server: first.server });
  assert.equal(third.runtime.selectBoot().bundleId, release.manifest.bundleId);
  assert.equal(third.api.getStatus().trial, false);
  assert.deepEqual(third.events.backups, []);
  assert.equal((await third.api.check({ manual: true })).message, "当前已是最新版本");
  // 整包更新检查据此判断：1.6.3 已在运行，1.6.4 仍需整包
  assert.equal(third.api.covers("1.6.3"), true);
  assert.equal(third.api.covers("1.6.4"), false);
  assert.equal(first.api.covers("1.6.2"), true, "安装包自带的版本覆盖它自己");
});

async function stagedHarness(t, version = "1.6.3", options = {}) {
  const first = harness(t, options);
  first.runtime.selectBoot();
  const release = makeRelease(version);
  publish(first.server, release);
  await first.api.check({ manual: true });
  return { first, release, boot: () => harness(t, { stateDir: first.stateDir, server: first.server }) };
}

test("新包两次启动都没被确认就绪：第三次启动屏蔽它，退回安装包自带的版本", async (t) => {
  const { release, boot } = await stagedHarness(t);
  assert.equal(boot().runtime.selectBoot().bundleId, release.manifest.bundleId);
  assert.equal(boot().runtime.selectBoot().bundleId, release.manifest.bundleId);
  const third = boot();
  assert.equal(third.runtime.selectBoot(), null);
  const state = readState(third.stateDir);
  assert.ok(state.blocked.includes(release.manifest.bundleId));
  assert.match(state.lastRollback.reason, /连续 2 次/);
  assert.equal((await third.api.check({ manual: true })).message, "上次更新启动失败，已跳过这个版本");
});

test("启动超时：屏蔽新包并立即重启到旧版本", async (t) => {
  const { release, boot } = await stagedHarness(t);
  const trial = boot();
  trial.runtime.selectBoot();
  trial.events.timers[0].callback();
  assert.equal(trial.events.relaunches, 1);
  assert.match(readState(trial.stateDir).lastRollback.reason, /启动超时/);
  assert.equal(boot().runtime.selectBoot(), null);
  assert.ok(readState(trial.stateDir).blocked.includes(release.manifest.bundleId));
});

test("主进程加载阶段抛错：屏蔽新包并重启；安装包自带的版本出错则照常抛出", async (t) => {
  const { release, boot } = await stagedHarness(t);
  const trial = boot();
  trial.runtime.selectBoot();
  trial.runtime.loadEntry(() => { throw new Error("syntax error in main.js"); });
  assert.equal(trial.events.relaunches, 1);
  assert.ok(readState(trial.stateDir).blocked.includes(release.manifest.bundleId));
  const builtin = boot();
  assert.equal(builtin.runtime.selectBoot(), null);
  assert.throws(() => builtin.runtime.loadEntry(() => { throw new Error("builtin broken"); }), /builtin broken/);
});

test("包内文件被改动或多出文件：启动时校验失败，退回旧版本并屏蔽", async (t) => {
  for (const mutate of [
    (root) => fs.appendFileSync(path.join(root, "electron/main.js"), "require('child_process').exec('evil')"),
    (root) => fs.writeFileSync(path.join(root, "electron/injected.js"), "evil"),
  ]) {
    const { first, release, boot } = await stagedHarness(t);
    mutate(path.join(first.stateDir, "bundles", release.manifest.bundleId));
    const next = boot();
    assert.equal(next.runtime.selectBoot(), null);
    assert.match(readState(next.stateDir).lastRollback.reason, /校验失败/);
  }
});

test("启动因网络等环境原因失败时，不计入试运行次数", async (t) => {
  const { release, boot } = await stagedHarness(t);
  for (let index = 0; index < 4; index++) {
    const trial = boot();
    assert.equal(trial.runtime.selectBoot().bundleId, release.manifest.bundleId);
    trial.api.reportEnvironmentFailure("remote-unreachable");
  }
});

test("换了安装包（壳指纹变化）：旧状态和旧包全部作废", async (t) => {
  const { first, boot } = await stagedHarness(t);
  boot().runtime.selectBoot();
  const next = harness(t, { stateDir: first.stateDir, server: first.server, anchors: { ...anchors, runtimeVersion: "e2-0123456789abcdef" } });
  assert.equal(next.runtime.selectBoot(), null);
  const bundlesDir = path.join(first.stateDir, "bundles");
  assert.ok(!fs.existsSync(bundlesDir) || fs.readdirSync(bundlesDir).length === 0, "旧包应全部删除");
  assert.equal(readState(first.stateDir).runtimeVersion, "e2-0123456789abcdef");
});

test("当前运行的包被撤回：下次启动退回安装包自带的版本", async (t) => {
  const { first, release, boot } = await stagedHarness(t);
  const running = boot();
  running.runtime.selectBoot();
  running.api.markReady();
  publish(first.server, makeRelease("1.6.3", { sequence: 200, revoked: [release.manifest.bundleId] }));
  const status = await running.api.check({ manual: true });
  assert.equal(status.phase, "ready");
  assert.equal(status.restartRequired, true);
  assert.equal(boot().runtime.selectBoot(), null);
});

test("拒绝：签名不对、zip 被篡改、zip 内容与清单不符、壳不同、版本不更高、序号回退", async (t) => {
  const t1 = harness(t);
  t1.runtime.selectBoot();
  const other = generateKeyPairSync("rsa", { modulusLength: 3072 });
  publish(t1.server, makeRelease("1.6.3", { signer: other.privateKey }));
  assert.match((await t1.api.check({ manual: true })).message, /没有安装包信任的签名/);

  const tamperedZip = makeRelease("1.6.3");
  publish(t1.server, tamperedZip);
  t1.server.set(tamperedZip.manifest.urls[0], Buffer.concat([tamperedZip.zip, Buffer.from("x")]));
  assert.match((await t1.api.check({ manual: true })).message, /大小或摘要不符/);

  // 签名合法、zip 完好，但签名清单里的文件表与 zip 内容不符：写盘前就拒绝
  publish(t1.server, makeRelease("1.6.3", { mutateManifest: (manifest) => { manifest.files["electron/main.js"] = "0".repeat(64); } }));
  assert.match((await t1.api.check({ manual: true })).message, /摘要不符/);
  const staged = path.join(t1.stateDir, "bundles");
  assert.ok(!fs.existsSync(staged) || fs.readdirSync(staged).length === 0, "不符的包不应写到磁盘上");

  publish(t1.server, makeRelease("1.6.3", { runtimeVersion: "e2-0123456789abcdef" }));
  t1.server.set(`${ORIGIN}/hot/stable/desktop/${RUNTIME}.json`, makeRelease("1.6.3", { runtimeVersion: "e2-0123456789abcdef" }).envelope);
  assert.equal((await t1.api.check({ manual: true })).message, "新版本需要安装新的安装包");

  publish(t1.server, makeRelease("1.6.2", { sequence: 300 }));
  assert.equal((await t1.api.check({ manual: true })).message, "当前已是最新版本");
  publish(t1.server, makeRelease("1.6.4", { sequence: 50 }));
  assert.match((await t1.api.check({ manual: true })).message, /已忽略/);
  assert.equal(readState(t1.stateDir).pending, null);
});

test("暂无热更新、开发构建、商店版：都不会下载任何东西", async (t) => {
  const none = harness(t);
  none.runtime.selectBoot();
  assert.equal((await none.api.check({ manual: true })).message, "当前安装包暂无可用的热更新");
  const dev = harness(t, { anchors: null, disabledReason: "development-build" });
  assert.equal(dev.runtime.selectBoot(), null);
  assert.equal((await dev.api.check({ manual: true })).phase, "disabled");
  assert.equal(fs.existsSync(path.join(dev.stateDir, "state.json")), false);
});

test("自动检查：关闭开关或新包试运行中时不检查；调度器启动 30 秒后检查", async (t) => {
  const { boot } = await stagedHarness(t);
  const trial = boot();
  trial.runtime.selectBoot();
  const before = trial.api.getStatus().phase;
  assert.equal((await trial.api.check()).phase, before);
  trial.api.markReady();
  trial.api.setAutoDownload(false);
  assert.equal((await trial.api.check()).phase, before);
  assert.equal(readState(trial.stateDir).autoDownload, false);
  const stop = trial.api.startScheduler();
  const scheduled = trial.events.timers.at(-1);
  assert.equal(scheduled.delay, 30_000);
  stop();
  assert.equal(scheduled.cleared, true);
});

test("加载器配置：正式包读 package.json 的锚点；商店版、开发构建停用；测试锚点只在未打包时生效", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-hot-loader-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shellDir = path.join(root, "electron");
  fs.mkdirSync(shellDir);
  fs.copyFileSync(new URL("../storeChannel.js", import.meta.url), path.join(shellDir, "storeChannel.js"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ nowenHotUpdate: { runtimeVersion: RUNTIME, publicKey: anchors.publicKeyPem, keyId } }));
  const packaged = readConfig({ app: { isPackaged: true }, shellDir });
  assert.deepEqual(packaged.anchors, anchors);
  assert.equal(packaged.channel.urls(RUNTIME)[0], `https://download.nowen.cn/hot/stable/desktop/${RUNTIME}.json`);
  assert.equal(readConfig({ app: { isPackaged: false }, shellDir }).disabledReason, "development-build");
  const testAnchors = path.join(root, "anchors.json");
  fs.writeFileSync(testAnchors, JSON.stringify({ runtimeVersion: RUNTIME, publicKey: anchors.publicKeyPem, keyId, channelOrigin: "http://127.0.0.1:8787", readyTimeoutMs: 20000 }));
  process.env.NOWEN_HOT_UPDATE_TEST_ANCHORS = testAnchors;
  t.after(() => delete process.env.NOWEN_HOT_UPDATE_TEST_ANCHORS);
  const dev = readConfig({ app: { isPackaged: false }, shellDir });
  assert.deepEqual(dev.channel.allowedOrigins, ["http://127.0.0.1:8787"]);
  assert.equal(dev.readyTimeoutMs, 20000);
  assert.deepEqual(readConfig({ app: { isPackaged: true }, shellDir }).anchors, anchors, "正式包忽略测试锚点");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({}));
  assert.equal(readConfig({ app: { isPackaged: true }, shellDir }).disabledReason, "no-runtime");
});

test("升级前备份：复制数据库三件套并只保留最近 3 份", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-hot-backup-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  assert.equal(createPreUpdateBackup({ dataDir, fromVersion: "1.6.2", toVersion: "1.6.3" }), null);
  fs.writeFileSync(path.join(dataDir, "nowen-note.db"), "db");
  fs.writeFileSync(path.join(dataDir, "nowen-note.db-wal"), "wal");
  for (let index = 0; index < 5; index++) {
    createPreUpdateBackup({ dataDir, fromVersion: "1.6.2", toVersion: "1.6.3", reason: "hot-update", now: new Date(Date.UTC(2026, 10, 22, 0, 0, index)) });
  }
  const backups = fs.readdirSync(path.join(dataDir, "backups-pre-update")).sort();
  assert.equal(backups.length, 3);
  const latest = path.join(dataDir, "backups-pre-update", backups.at(-1));
  assert.equal(fs.readFileSync(path.join(latest, "nowen-note.db"), "utf8"), "db");
  assert.equal(fs.readFileSync(path.join(latest, "nowen-note.db-wal"), "utf8"), "wal");
  assert.equal(JSON.parse(fs.readFileSync(path.join(latest, "update.json"), "utf8")).reason, "hot-update");
});

const tempDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("后端依赖：启动包时把 backend/node_modules 链接到安装目录；安装目录变了就重建；删包不动安装目录", async (t) => {
  const shellModules = tempDir(t, "nowen-hot-shell-modules-");
  fs.writeFileSync(path.join(shellModules, "keep.txt"), "shell");
  const first = harness(t, { backendModulesDir: shellModules });
  first.runtime.selectBoot();
  const v3 = makeRelease("1.6.3");
  publish(first.server, v3);
  await first.api.check({ manual: true });
  const boot = (backendModulesDir) => harness(t, { stateDir: first.stateDir, server: first.server, backendModulesDir });

  const trial = boot(shellModules);
  const root = trial.runtime.selectBoot().root;
  const link = path.join(root, "backend", "node_modules");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(link), fs.realpathSync(shellModules));
  trial.api.markReady();

  // 链接不算包里多出的文件；安装目录换了位置（AppImage 每次挂载点不同）时链接跟着更新
  const moved = tempDir(t, "nowen-hot-shell-moved-");
  fs.writeFileSync(path.join(moved, "keep.txt"), "moved");
  assert.equal(boot(moved).runtime.selectBoot().bundleId, v3.manifest.bundleId);
  assert.equal(fs.realpathSync(link), fs.realpathSync(moved));

  // 新版本取代旧包：旧包目录连同链接一起删掉，链接指向的安装目录原样保留
  const v4 = makeRelease("1.6.4", { sequence: 200 });
  publish(first.server, v4);
  const running = boot(moved);
  running.runtime.selectBoot();
  await running.api.check({ manual: true });
  const next = boot(moved);
  assert.equal(next.runtime.selectBoot().bundleId, v4.manifest.bundleId);
  next.api.markReady();
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.readFileSync(path.join(moved, "keep.txt"), "utf8"), "moved");
  assert.equal(fs.readFileSync(path.join(shellModules, "keep.txt"), "utf8"), "shell");

  // 装了新安装包：所有旧包作废，同样不会顺着链接删到安装目录
  const reinstalled = harness(t, { stateDir: first.stateDir, server: first.server, backendModulesDir: moved, anchors: { ...anchors, runtimeVersion: "e2-0123456789abcdef" } });
  assert.equal(reinstalled.runtime.selectBoot(), null);
  assert.equal(fs.readFileSync(path.join(moved, "keep.txt"), "utf8"), "moved");
});

test("后端依赖目录不存在：不运行这个包，退回安装包自带的版本", async (t) => {
  const missing = path.join(tempDir(t, "nowen-hot-shell-missing-"), "node_modules");
  const { first, release } = await stagedHarness(t);
  const next = harness(t, { stateDir: first.stateDir, server: first.server, backendModulesDir: missing });
  assert.equal(next.runtime.selectBoot(), null);
  const state = readState(first.stateDir);
  assert.ok(state.blocked.includes(release.manifest.bundleId));
  assert.equal(state.lastRollback.reason, "无法使用安装目录里的后端依赖");
});

test("热更新包里的主进程代码能 require 安装包的依赖；包外的文件不受影响", (t) => {
  const root = tempDir(t, "nowen-hot-modules-");
  const modules = path.join(root, "shell", "node_modules");
  fs.mkdirSync(path.join(modules, "nowen-hot-test-dep"), { recursive: true });
  fs.writeFileSync(path.join(modules, "nowen-hot-test-dep", "index.js"), "module.exports = 'from-shell';\n");
  const electronDir = path.join(root, "bundles", "1.6.3-aaaaaaaa", "electron");
  fs.mkdirSync(path.join(electronDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(electronDir, "main.js"), "module.exports = require('./lib/updater');\n");
  fs.writeFileSync(path.join(electronDir, "lib", "updater.js"), "module.exports = require('nowen-hot-test-dep');\n");
  const outside = path.join(root, "bundles", "outside.js");
  fs.writeFileSync(outside, "module.exports = require('nowen-hot-test-dep');\n");
  // 改 Module.globalPaths 不生效，这也是不能用它的原因
  require("node:module").globalPaths.push(modules);
  t.after(() => require("node:module").globalPaths.pop());
  assert.throws(() => require(path.join(electronDir, "main.js")), /Cannot find module 'nowen-hot-test-dep'/);
  const restore = addBundleModulePaths(electronDir, modules);
  t.after(restore);
  assert.equal(require(path.join(electronDir, "main.js")), "from-shell");
  assert.throws(() => require(outside), /Cannot find module 'nowen-hot-test-dep'/);
});

test("热更新触发的重启改用主进程注册的方式：先停后端再退出", async (t) => {
  const { boot } = await stagedHarness(t);
  const trial = boot();
  trial.runtime.selectBoot();
  const calls = [];
  trial.api.setRelaunch(() => calls.push("relaunchApp"));
  trial.events.timers[0].callback();
  assert.deepEqual(calls, ["relaunchApp"]);
  assert.equal(trial.events.relaunches, 0, "不再走加载器里直接 app.exit 的重启");

  const source = fs.readFileSync(new URL("../main.js", import.meta.url), "utf8");
  assert.match(source, /hotUpdate\?\.setRelaunch\?\.\(relaunchApp\);/);
  const body = source.slice(source.indexOf("function relaunchApp()"), source.indexOf("app.exit(0);", source.indexOf("function relaunchApp()")));
  assert.match(body, /stopBackend\(\)/, "relaunchApp 在 app.exit 之前停掉后端");
});
