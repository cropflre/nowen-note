// 在临时 git 仓库里跑完整的 打包 → 签名 → 校验 → 渠道地址 流程，私钥全部是临时生成的。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildBundles } from "../hot-update/build-bundles.mjs";
import { generateKeys } from "../hot-update/generate-keys.mjs";
import { publicKeyId, toPublicPem } from "../hot-update/lib/keys.mjs";
import { openEnvelope } from "../hot-update/lib/manifest.mjs";
import { parseTrustedKeys } from "../hot-update/lib/keys.mjs";
import { readZip } from "../hot-update/lib/zip.mjs";
import { decidePointer } from "../hot-update/pointer.mjs";
import { signBundles } from "../hot-update/sign.mjs";
import { verifyBundles } from "../hot-update/verify.mjs";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../hot-update");
const key = generateKeyPairSync("rsa", { modulusLength: 3072 });
const privatePem = key.privateKey.export({ type: "pkcs8", format: "pem" });
const keyId = publicKeyId(key.publicKey);
const keysJson = { schema: 1, keys: [{ id: keyId, pem: toPublicPem(key.publicKey) }] };
const trusted = parseTrustedKeys(keysJson);

function write(root, file, content) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
}

function git(root, args, date = "2026-11-20T08:00:00Z") {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_NOSYSTEM: "1", HOME: root },
  }).trim();
}

function setVersion(root, version) {
  write(root, "package.json", JSON.stringify({ name: "nowen-note", version, dependencies: { "electron-updater": "^6.3.9" }, devDependencies: { electron: "43.8.4" } }));
}

function makeRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nowen-hot-repo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  setVersion(root, "1.6.2");
  write(root, "package-lock.json", JSON.stringify({ packages: { "node_modules/electron": { version: "43.8.4" }, "node_modules/electron-updater": { version: "6.3.9" } } }));
  write(root, "hot-update/config.json", JSON.stringify({ schema: 1, runtimeEpoch: { android: 1, desktop: 1 }, revokedBundleIds: { android: [], desktop: [] } }));
  write(root, "hot-update/public-keys.json", JSON.stringify(keysJson));
  write(root, "backend/build.bundle.mjs", 'const external = [\n  "better-sqlite3",\n];\n');
  write(root, "backend/package-lock.json", JSON.stringify({ packages: { "node_modules/better-sqlite3": { version: "12.0.0" } } }));
  write(root, "backend/package.json", JSON.stringify({ name: "backend", version: "1.6.2" }));
  write(root, "electron/main-bootstrap.js", "require('./main.js');\n");
  write(root, "electron/main.js", "console.log('main');\n");
  write(root, "electron/preload.js", "console.log('preload');\n");
  write(root, "electron/clipper-host.js", "host\n");
  write(root, "electron/clipper-native-host.js", "native\n");
  write(root, "electron/builder.config.js", "module.exports = {};\n");
  write(root, "electron/__tests__/main.test.js", "test\n");
  write(root, "electron/icon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write(root, "frontend/capacitor.config.ts", "export default {};\n");
  write(root, "frontend/package-lock.json", JSON.stringify({ packages: { "node_modules/@capacitor/android": { version: "8.4.3" }, "node_modules/@capacitor/core": { version: "8.4.3" } } }));
  write(root, "frontend/android/capacitor.settings.gradle", "project(':capacitor-android').projectDir = new File('../node_modules/@capacitor/android/capacitor')\n");
  write(root, "frontend/android/app/build.gradle", 'android {\n  versionCode 10602\n  versionName "1.6.2"\n}\n');
  write(root, ".gitignore", "frontend/dist/\nbackend/dist/\n");
  // 构建产物（不进 git）
  write(root, "frontend/dist/index.html", "<!doctype html><script type=module src=/assets/index-abc.js></script>");
  write(root, "frontend/dist/assets/index-abc.js", "console.log('ui');\n".repeat(50));
  write(root, "frontend/dist/.DS_Store", "junk");
  write(root, "backend/dist/index.js", "console.log('backend');\n".repeat(50));
  write(root, "backend/templates/empty.docx", Buffer.from("PK fake docx"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "ci@example.invalid"]);
  git(root, ["config", "user.name", "ci"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

async function release(t, root, out) {
  const outDir = path.join(root, "..", `${path.basename(root)}-${out}`);
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  await buildBundles({ repoRoot: root, outDir });
  await signBundles({ dir: outDir, privateKeyPem: privatePem, keysFile: path.join(root, "hot-update/public-keys.json") });
  return outDir;
}

function verify(root, dir, extra = {}) {
  return verifyBundles({ dir, version: "1.6.2", keysFile: path.join(root, "hot-update/public-keys.json"), repoRoot: root, checkRuntime: true, ...extra });
}

function envelopeOf(dir, target) {
  return readFileSync(path.join(dir, readdirSync(dir).find((name) => name.startsWith(`nowen-hot-${target}-e`))));
}

test("打包、签名、校验全流程通过，产物只有 2 个 zip 和 2 个签名清单", async (t) => {
  const root = makeRepo(t);
  const dir = await release(t, root, "out");
  const names = readdirSync(dir).sort();
  assert.equal(names.length, 4);
  assert.deepEqual(names.filter((name) => name.endsWith(".zip")), ["nowen-hot-android-1.6.2.zip", "nowen-hot-desktop-1.6.2.zip"]);
  const results = await verify(root, dir, { commit: git(root, ["rev-parse", "HEAD"]) });
  assert.deepEqual(results.map((item) => item.target), ["android", "desktop"]);

  const desktop = readZip(readFileSync(path.join(dir, "nowen-hot-desktop-1.6.2.zip"))).map((entry) => entry.path);
  assert.ok(desktop.includes("electron/main.js") && desktop.includes("electron/icon.png") && desktop.includes("electron/clipper-host.js"));
  assert.ok(desktop.includes("backend/templates/empty.docx") && desktop.includes("backend/package.json"));
  for (const excluded of ["electron/main-bootstrap.js", "electron/builder.config.js", "electron/__tests__/main.test.js", "frontend/dist/.DS_Store"]) {
    assert.ok(!desktop.includes(excluded), excluded);
  }
  const android = readZip(readFileSync(path.join(dir, "nowen-hot-android-1.6.2.zip"))).map((entry) => entry.path);
  assert.deepEqual(android, ["assets/index-abc.js", "index.html"]);

  const { manifest } = openEnvelope(envelopeOf(dir, "desktop"), trusted);
  assert.equal(manifest.sequence, Math.floor(Date.parse("2026-11-20T08:00:00Z") / 1000));
  assert.deepEqual(manifest.urls, [
    "https://download.nowen.cn/hot/v1.6.2/nowen-hot-desktop-1.6.2.zip",
    "https://github.com/cropflre/nowen-note/releases/download/v1.6.2/nowen-hot-desktop-1.6.2.zip",
  ]);
});

test("同一提交打包两次，zip 和清单逐字节相同", async (t) => {
  const root = makeRepo(t);
  const first = await release(t, root, "first");
  const second = await release(t, root, "second");
  for (const name of readdirSync(first)) assert.ok(readFileSync(path.join(first, name)).equals(readFileSync(path.join(second, name))), name);
});

test("篡改 zip、篡改清单、多余文件、版本或提交不符、壳变了都会被拒绝", async (t) => {
  const root = makeRepo(t);
  const dir = await release(t, root, "tamper");
  const scenario = async (label, mutate, expected, extra) => {
    const copy = `${dir}-${label}`;
    cpSync(dir, copy, { recursive: true });
    t.after(() => rmSync(copy, { recursive: true, force: true }));
    mutate(copy);
    await assert.rejects(verify(root, copy, extra), expected, label);
  };
  await scenario("zip", (copy) => {
    const file = path.join(copy, "nowen-hot-android-1.6.2.zip");
    const bytes = readFileSync(file);
    bytes[bytes.length - 30] ^= 0xff;
    writeFileSync(file, bytes);
  }, /SHA-256/);
  await scenario("manifest", (copy) => {
    const file = path.join(copy, readdirSync(copy).find((name) => name.startsWith("nowen-hot-desktop-e")));
    const envelope = JSON.parse(readFileSync(file, "utf8"));
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString());
    payload.urls = ["https://download.nowen.cn/hot/v1.6.2/other.zip"];
    envelope.payload = Buffer.from(JSON.stringify(payload)).toString("base64");
    writeFileSync(file, JSON.stringify(envelope));
  }, /签名校验失败/);
  await scenario("extra", (copy) => writeFileSync(path.join(copy, "notes.txt"), "x"), /多余文件/);
  await scenario("version", () => {}, /version/, { version: "1.6.3" });
  await scenario("commit", () => {}, /commit/, { commit: "b".repeat(40) });

  const otherKeys = path.join(root, "..", `${path.basename(root)}-other-keys.json`);
  const other = generateKeyPairSync("rsa", { modulusLength: 3072 });
  writeFileSync(otherKeys, JSON.stringify({ schema: 1, keys: [{ id: publicKeyId(other.publicKey), pem: toPublicPem(other.publicKey) }] }));
  t.after(() => rmSync(otherKeys, { force: true }));
  await assert.rejects(verify(root, dir, { keysFile: otherKeys }), /受信任/);

  // 壳文件变化并提交后，旧产物的 runtimeVersion 与源码不再一致
  write(root, "electron/main-bootstrap.js", "require('./hot-update/loader.js');\n");
  git(root, ["commit", "-q", "-am", "shell change"]);
  await assert.rejects(verify(root, dir), /runtimeVersion/);
});

test("私钥对应的公钥没有入库时拒绝签名；输出目录不为空时拒绝打包", async (t) => {
  const root = makeRepo(t);
  const outDir = path.join(root, "..", `${path.basename(root)}-unsigned`);
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  await buildBundles({ repoRoot: root, outDir });
  const stranger = generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey.export({ type: "pkcs8", format: "pem" });
  await assert.rejects(signBundles({ dir: outDir, privateKeyPem: stranger, keysFile: path.join(root, "hot-update/public-keys.json") }), /不在/);
  await assert.rejects(signBundles({ dir: outDir, privateKeyPem: "", keysFile: path.join(root, "hot-update/public-keys.json") }), /缺少/);
  await assert.rejects(buildBundles({ repoRoot: root, outDir }), /必须为空/);
  // 草稿没签名就校验 → 有多余文件、缺签名清单
  await assert.rejects(verify(root, outDir), /签名清单/);
});

test("渠道地址只向前移动：旧版本重跑发布不会把渠道指回去", async (t) => {
  const root = makeRepo(t);
  const older = await release(t, root, "v162");
  setVersion(root, "1.6.3");
  git(root, ["commit", "-q", "-am", "1.6.3"], "2026-11-25T08:00:00Z");
  const newer = await release(t, root, "v163");
  const olderEnvelope = envelopeOf(older, "android");
  const newerEnvelope = envelopeOf(newer, "android");
  assert.equal(openEnvelope(olderEnvelope, trusted).manifest.runtimeVersion, openEnvelope(newerEnvelope, trusted).manifest.runtimeVersion);

  assert.equal(decidePointer({ currentBytes: null, nextBytes: olderEnvelope, trustedKeys: trusted }).action, "update");
  assert.equal(decidePointer({ currentBytes: olderEnvelope, nextBytes: newerEnvelope, trustedKeys: trusted }).action, "update");
  assert.equal(decidePointer({ currentBytes: newerEnvelope, nextBytes: olderEnvelope, trustedKeys: trusted }).action, "skip");
  assert.equal(decidePointer({ currentBytes: newerEnvelope, nextBytes: newerEnvelope, trustedKeys: trusted }).action, "skip");
  assert.equal(decidePointer({ currentBytes: Buffer.from("corrupted"), nextBytes: olderEnvelope, trustedKeys: trusted }).action, "update");
  assert.throws(() => decidePointer({ currentBytes: envelopeOf(newer, "desktop"), nextBytes: newerEnvelope, trustedKeys: trusted }), /不一致/);
  assert.throws(() => decidePointer({ currentBytes: null, nextBytes: Buffer.from("{}"), trustedKeys: trusted }));
});

test("命令行：sign 只从环境变量取私钥，verify 和 pointer 输出可供 workflow 使用", async (t) => {
  const root = makeRepo(t);
  const outDir = path.join(root, "..", `${path.basename(root)}-cli`);
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const node = (script, args, env = {}) =>
    spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const keys = path.join(root, "hot-update/public-keys.json");
  assert.equal(node("build-bundles.mjs", ["--repo", root, "--out", outDir, "--version", "1.6.2"]).status, 0);
  const noKey = node("sign.mjs", ["--dir", outDir, "--keys", keys], { NOWEN_HOT_UPDATE_PRIVATE_KEY: "" });
  assert.notEqual(noKey.status, 0);
  assert.match(noKey.stderr, /NOWEN_HOT_UPDATE_PRIVATE_KEY/);
  const signed = node("sign.mjs", ["--dir", outDir, "--keys", keys], { NOWEN_HOT_UPDATE_PRIVATE_KEY: privatePem });
  assert.equal(signed.status, 0, signed.stderr);
  assert.doesNotMatch(signed.stdout + signed.stderr, /PRIVATE KEY/);
  const verified = node("verify.mjs", ["--dir", outDir, "--version", "1.6.2", "--keys", keys, "--repo", root, "--check-runtime"]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /verified android/);
  const envelope = path.join(outDir, readdirSync(outDir).find((name) => name.startsWith("nowen-hot-desktop-e")));
  const pointerKey = node("pointer.mjs", ["key", "--file", envelope, "--keys", keys]);
  assert.match(pointerKey.stdout.trim(), /^hot\/stable\/desktop\/e1-[0-9a-f]{16}\.json$/);
  const decision = node("pointer.mjs", ["decide", "--next", envelope, "--current", path.join(outDir, "missing.json"), "--keys", keys]);
  assert.equal(decision.stdout.trim(), "update", decision.stderr);
  const runtime = node("runtime-fingerprint.mjs", ["--repo", root]);
  assert.match(runtime.stdout, /"desktop":"e1-[0-9a-f]{16}"/);
});

test("生成密钥：私钥只能写在 git 工作区之外，公钥追加到列表", async (t) => {
  const root = makeRepo(t);
  await assert.rejects(generateKeys({ repoRoot: root, privateKeyOut: path.join(root, "private.pem") }), /git 工作区/);
  const outside = mkdtempSync(path.join(os.tmpdir(), "nowen-hot-key-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const result = await generateKeys({ repoRoot: root, privateKeyOut: path.join(outside, "private.pem"), now: new Date("2026-11-22T00:00:00Z") });
  assert.equal(statSync(result.privateKeyOut).mode & 0o777, 0o600);
  assert.match(readFileSync(result.privateKeyOut, "utf8"), /BEGIN PRIVATE KEY/);
  const keys = JSON.parse(readFileSync(path.join(root, "hot-update/public-keys.json"), "utf8"));
  assert.equal(keys.keys.length, 2);
  assert.equal(keys.keys[1].id, result.id);
  assert.equal(keys.keys[1].createdAt, "2026-11-22");
  assert.doesNotMatch(JSON.stringify(keys), /PRIVATE KEY/);
  await assert.rejects(generateKeys({ repoRoot: root, privateKeyOut: result.privateKeyOut }), /已存在/);
  assert.ok(!existsSync(path.join(root, "private.pem")));
});
