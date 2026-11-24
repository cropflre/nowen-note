#!/usr/bin/env node
// 校验一个版本的热更新产物：签名、摘要、文件清单、命名，以及（可选）与源码提交的壳指纹是否一致。
//
//   node scripts/hot-update/verify.mjs --dir release-hot --version X.Y.Z [--commit SHA] [--check-runtime]
//
// 公钥默认读入库的 hot-update/public-keys.json；只有测试会用 --keys 指向临时公钥。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT } from "./build-bundles.mjs";
import { computeRuntimeVersions, gitTreeReader } from "./lib/fingerprint.mjs";
import { loadTrustedKeys, verifyBytes } from "./lib/keys.mjs";
import { assetNames, bundleUrls, openEnvelope, sha256Hex, TARGETS } from "./lib/manifest.mjs";
import { readZip } from "./lib/zip.mjs";

const DESKTOP_REQUIRED = ["electron/main.js", "electron/preload.js", "frontend/dist/index.html", "backend/dist/index.js", "backend/package.json"];
const SHELL_ONLY = /^electron\/(main-bootstrap\.js|hot-update\/)/;

function checkContent(target, entries, manifest) {
  const paths = entries.map((entry) => entry.path).sort();
  if (target === "android") {
    if (!paths.includes("index.html")) throw new Error("安卓热更新包根目录必须是 index.html");
    if (manifest.files !== undefined) throw new Error("安卓清单不应包含 files");
    return;
  }
  for (const required of DESKTOP_REQUIRED) if (!paths.includes(required)) throw new Error(`桌面热更新包缺少 ${required}`);
  const shellFile = paths.find((entry) => SHELL_ONLY.test(entry));
  if (shellFile) throw new Error(`壳文件不能进入热更新包：${shellFile}`);
  const listed = Object.keys(manifest.files).sort();
  if (JSON.stringify(listed) !== JSON.stringify(paths)) throw new Error("桌面清单的 files 与 zip 内容不一致");
  for (const entry of entries) {
    if (manifest.files[entry.path] !== sha256Hex(entry.data)) throw new Error(`文件摘要不一致：${entry.path}`);
  }
}

export async function verifyBundles({
  dir,
  version,
  keysFile = path.join(DEFAULT_REPO_ROOT, "hot-update/public-keys.json"),
  commit,
  checkRuntime = false,
  repoRoot = DEFAULT_REPO_ROOT,
}) {
  if (!dir || !version) throw new Error("需要 --dir 和 --version");
  const trusted = await loadTrustedKeys(keysFile);
  if (!trusted.size) throw new Error("hot-update/public-keys.json 里没有公钥，无法校验热更新产物");
  const names = (await readdir(dir)).sort();
  const runtime = checkRuntime ? computeRuntimeVersions(gitTreeReader(repoRoot)) : null;
  const expected = new Set();
  const results = [];
  for (const target of TARGETS) {
    const envelopeNames = names.filter((name) => new RegExp(`^nowen-hot-${target}-e[1-9]\\d{0,5}-[0-9a-f]{16}\\.json$`).test(name));
    if (envelopeNames.length !== 1) throw new Error(`${target} 必须恰好有一个签名清单`);
    const { manifest, keyIds } = openEnvelope(await readFile(path.join(dir, envelopeNames[0])), trusted);
    if (manifest.target !== target || manifest.version !== version) throw new Error(`${envelopeNames[0]} 的 target 或 version 不符`);
    const assets = assetNames(target, version, manifest.runtimeVersion);
    if (envelopeNames[0] !== assets.manifest) throw new Error(`${envelopeNames[0]} 的文件名与 runtimeVersion 不一致`);
    if (runtime && manifest.runtimeVersion !== runtime[target]) {
      throw new Error(`${target} 的 runtimeVersion ${manifest.runtimeVersion} 与源码计算的 ${runtime[target]} 不一致`);
    }
    if (commit && manifest.commit !== commit) throw new Error(`${target} 清单的 commit 不是 ${commit}`);
    if (JSON.stringify(manifest.urls) !== JSON.stringify(bundleUrls(`v${version}`, assets.zip))) throw new Error(`${target} 清单的下载地址不符`);
    if (!names.includes(assets.zip)) throw new Error(`缺少 ${assets.zip}`);
    const zip = await readFile(path.join(dir, assets.zip));
    if (zip.length !== manifest.size || sha256Hex(zip) !== manifest.sha256) throw new Error(`${assets.zip} 的大小或 SHA-256 与清单不符`);
    if (![...trusted.values()].some((key) => verifyBytes(key, zip, manifest.zipSignature))) throw new Error(`${assets.zip} 的签名校验失败`);
    checkContent(target, readZip(zip), manifest);
    expected.add(assets.zip).add(assets.manifest);
    results.push({ target, runtimeVersion: manifest.runtimeVersion, bundleId: manifest.bundleId, size: manifest.size, keyIds });
  }
  const unexpected = names.filter((name) => !expected.has(name));
  if (unexpected.length) throw new Error(`热更新产物目录里有多余文件：${unexpected.join(", ")}`);
  return results;
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      version: { type: "string" },
      keys: { type: "string" },
      commit: { type: "string" },
      "check-runtime": { type: "boolean", default: false },
      repo: { type: "string" },
    },
  });
  const results = await verifyBundles({
    dir: values.dir && path.resolve(values.dir),
    version: values.version,
    commit: values.commit,
    checkRuntime: values["check-runtime"],
    ...(values.keys ? { keysFile: path.resolve(values.keys) } : {}),
    ...(values.repo ? { repoRoot: path.resolve(values.repo) } : {}),
  });
  for (const item of results) {
    console.log(`[hot-update] verified ${item.target}: bundle ${item.bundleId}, runtime ${item.runtimeVersion}, ${item.size} bytes, key ${item.keyIds.join(",")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[hot-update] ${error.message}`);
    process.exitCode = 1;
  });
}
