#!/usr/bin/env node
// 核对打包好的桌面应用里的热更新信任锚点：app.asar 里 package.json 的 nowenHotUpdate
// 必须与源码提交算出的壳指纹、公钥列表第一把一致。不一致的安装包装上后收不到热更新，
// 或者信任了错误的公钥。CI 在 electron-builder 之后运行（与安卓 android-stage 的核对对应）：
//
//   node scripts/hot-update/verify-desktop-anchors.mjs [--dist dist-electron]
import { appendFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_REPO_ROOT } from "./build-bundles.mjs";
import { computeRuntimeVersions, gitTreeReader } from "./lib/fingerprint.mjs";

const require = createRequire(import.meta.url);
const FIELD_LABELS = { runtimeVersion: "壳指纹", publicKey: "公钥", keyId: "公钥 ID" };

/** 打包产物里所有的 app.asar（Windows/Linux 的 *-unpacked，macOS 的 *.app）；不进入符号链接和 .asar.unpacked。 */
export async function findAppArchives(dist) {
  const found = [];
  const visit = async (dir, depth) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "app.asar") found.push(full);
      else if (entry.isDirectory() && depth < 5 && !entry.name.endsWith(".asar.unpacked")) await visit(full, depth + 1);
    }
  };
  await visit(dist, 0);
  return found.sort();
}

/** 源码提交应当写进安装包的锚点（与 electron/builder.base.config.js 的 extraMetadata 同源）。 */
export function expectedDesktopAnchors(reader) {
  const key = (JSON.parse(reader.read("hot-update/public-keys.json").toString("utf8")).keys || [])[0];
  return { runtimeVersion: computeRuntimeVersions(reader).desktop, publicKey: key?.pem ?? "", keyId: key?.id ?? "" };
}

export function checkDesktopAnchors(packageJson, expected) {
  const anchors = packageJson?.nowenHotUpdate;
  if (!anchors || typeof anchors !== "object") throw new Error("package.json 里没有 nowenHotUpdate（打包配置的 extraMetadata 没有生效）");
  for (const field of Object.keys(FIELD_LABELS)) {
    if ((anchors[field] ?? "") !== expected[field]) throw new Error(`热更新${FIELD_LABELS[field]}与源码提交不一致`);
  }
}

export async function verifyDesktopAnchors({ dist, expected }) {
  const archives = await findAppArchives(dist);
  if (!archives.length) throw new Error(`${dist} 里没有打包好的 app.asar`);
  const { extractFile } = require("@electron/asar");
  for (const archive of archives) {
    try {
      checkDesktopAnchors(JSON.parse(extractFile(archive, "package.json").toString("utf8")), expected);
    } catch (error) {
      throw new Error(`${archive}：${error.message}`);
    }
  }
  return archives;
}

async function main() {
  const { values } = parseArgs({ options: { dist: { type: "string", default: "dist-electron" } } });
  const expected = expectedDesktopAnchors(gitTreeReader(DEFAULT_REPO_ROOT));
  const archives = await verifyDesktopAnchors({ dist: path.resolve(values.dist), expected });
  const key = expected.keyId ? `公钥 ${expected.keyId}` : "没有公钥：这些安装包不接受热更新";
  const line = `桌面热更新锚点与源码一致（${archives.length} 个 app.asar）：壳指纹 ${expected.runtimeVersion}，${key}`;
  console.log(`[hot-update] ${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[hot-update] ${error.message}`);
    process.exitCode = 1;
  });
}
