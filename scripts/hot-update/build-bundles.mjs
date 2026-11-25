#!/usr/bin/env node
// 用本次构建好的 frontend/dist、backend/dist 等产物生成热更新包和未签名的清单草稿。
//
//   node scripts/hot-update/build-bundles.mjs --out release-hot [--version X.Y.Z]
//
// 输出：nowen-hot-<target>-<version>.zip 和 draft-<target>.json；草稿由 sign.mjs 签名后删除。
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { computeRuntimeVersions, gitTreeReader } from "./lib/fingerprint.mjs";
import { assetNames, buildDraftManifest, sha256Hex, TARGETS } from "./lib/manifest.mjs";
import { createZip } from "./lib/zip.mjs";

export const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db"]);
// 这些 electron 文件不进热更新包：测试、打包配置、打包时下载的 node，以及永远属于壳的 bootstrap 和加载器。
const ELECTRON_EXCLUDED = [
  /^electron\/__tests__\//,
  /^electron\/builder[^/]*\.js$/,
  /^electron\/node\//,
  /^electron\/main-bootstrap\.js$/,
  /^electron\/hot-update\//,
];
const DESKTOP_REQUIRED = ["electron/main.js", "electron/preload.js", "frontend/dist/index.html", "backend/dist/index.js", "backend/package.json"];

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function regularFile(abs, label) {
  const info = await lstat(abs).catch(() => null);
  if (!info) throw new Error(`缺少热更新包需要的文件：${label}`);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`热更新包只接受常规文件：${label}`);
}

async function walk(root, label) {
  const info = await lstat(root).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error(`缺少构建产物目录：${label}（请先构建）`);
  const files = [];
  const visit = async (dir, prefix) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`构建产物里不允许符号链接：${label}/${rel}`);
      if (entry.isDirectory()) await visit(abs, rel);
      else if (entry.isFile()) files.push({ path: rel, abs });
      else throw new Error(`构建产物里有非常规文件：${label}/${rel}`);
    }
  };
  await visit(root, "");
  return files;
}

export async function collectBundleFiles(repoRoot) {
  const frontend = await walk(path.join(repoRoot, "frontend/dist"), "frontend/dist");
  if (!frontend.some((file) => file.path === "index.html")) throw new Error("frontend/dist 里没有 index.html");
  const prefixed = (files, prefix) => files.map((file) => ({ path: `${prefix}/${file.path}`, abs: file.abs }));
  const electron = [];
  for (const file of git(repoRoot, ["ls-files", "-z", "--", "electron"]).split("\0").filter(Boolean)) {
    if (ELECTRON_EXCLUDED.some((pattern) => pattern.test(file))) continue;
    const abs = path.join(repoRoot, file);
    await regularFile(abs, file);
    electron.push({ path: file, abs });
  }
  const backendPackage = path.join(repoRoot, "backend/package.json");
  await regularFile(backendPackage, "backend/package.json");
  const desktop = [
    ...prefixed(frontend, "frontend/dist"),
    ...prefixed(await walk(path.join(repoRoot, "backend/dist"), "backend/dist"), "backend/dist"),
    ...prefixed(await walk(path.join(repoRoot, "backend/templates"), "backend/templates"), "backend/templates"),
    { path: "backend/package.json", abs: backendPackage },
    ...electron,
  ];
  for (const required of DESKTOP_REQUIRED) {
    if (!desktop.some((file) => file.path === required)) throw new Error(`桌面热更新包缺少 ${required}`);
  }
  return { android: frontend, desktop };
}

export async function buildBundles({ repoRoot = DEFAULT_REPO_ROOT, outDir, version } = {}) {
  if (!outDir) throw new Error("需要 --out 输出目录");
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  if (version && version !== pkg.version) throw new Error(`--version ${version} 与 package.json 的 ${pkg.version} 不一致`);
  const releaseVersion = pkg.version;
  const commit = git(repoRoot, ["rev-parse", "HEAD"]);
  const commitTime = Number(git(repoRoot, ["show", "-s", "--format=%ct", "HEAD"]));
  const reader = gitTreeReader(repoRoot);
  const runtime = computeRuntimeVersions(reader);
  const config = JSON.parse(reader.read("hot-update/config.json").toString("utf8"));
  const files = await collectBundleFiles(repoRoot);

  await mkdir(outDir, { recursive: true });
  if ((await readdir(outDir)).length) throw new Error(`输出目录必须为空：${outDir}`);
  const results = [];
  for (const target of TARGETS) {
    const entries = await Promise.all(files[target].map(async (file) => ({ path: file.path, data: await readFile(file.abs) })));
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const zip = createZip(entries);
    const names = assetNames(target, releaseVersion, runtime[target]);
    const draft = buildDraftManifest({
      target,
      version: releaseVersion,
      runtimeVersion: runtime[target],
      commit,
      commitTime,
      zip,
      files: target === "desktop" ? Object.fromEntries(entries.map((entry) => [entry.path, sha256Hex(entry.data)])) : undefined,
      revokedBundleIds: config?.revokedBundleIds?.[target] ?? [],
    });
    await writeFile(path.join(outDir, names.zip), zip, { flag: "wx" });
    await writeFile(path.join(outDir, `draft-${target}.json`), `${JSON.stringify(draft, null, 2)}\n`, { flag: "wx" });
    results.push({ target, zip: names.zip, size: zip.length, files: entries.length, runtimeVersion: runtime[target], bundleId: draft.bundleId });
  }
  return results;
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" }, version: { type: "string" }, repo: { type: "string" } } });
  const results = await buildBundles({ repoRoot: values.repo ? path.resolve(values.repo) : DEFAULT_REPO_ROOT, outDir: values.out && path.resolve(values.out), version: values.version });
  for (const item of results) {
    console.log(`[hot-update] ${item.target}: ${item.zip} ${item.size} bytes, ${item.files} files, runtime ${item.runtimeVersion}, bundle ${item.bundleId}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[hot-update] ${error.message}`);
    process.exitCode = 1;
  });
}
