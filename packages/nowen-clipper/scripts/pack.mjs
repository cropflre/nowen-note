#!/usr/bin/env node
/**
 * 打包扩展为 zip（用于上传 Chrome Web Store 或分发）。
 * 输入：dist/ 构建产物
 * 输出：releases/nowen-clipper-<version>.zip
 */
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 这里用 archiver 更方便，但为了避免新增依赖，用 JSZip（node 端亦可）。
// JSZip 已在 backend 里用过，属于项目内已有依赖生态，新加到 devDeps 也合理。
import JSZip from "jszip";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "dist");
const out = join(root, "releases");

if (!existsSync(dist)) {
  console.error("[pack] dist 不存在，先运行 `npm run build`");
  process.exit(1);
}
if (!existsSync(out)) mkdirSync(out, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const zipName = `nowen-clipper-${pkg.version}.zip`;
const zipPath = join(out, zipName);

const zip = new JSZip();

function addDir(baseZip, absDir, relDir = "") {
  for (const entry of readdirSync(absDir)) {
    const abs = join(absDir, entry);
    const rel = relDir ? `${relDir}/${entry}` : entry;
    const st = statSync(abs);
    if (st.isDirectory()) addDir(baseZip, abs, rel);
    else baseZip.file(rel, readFileSync(abs));
  }
}
addDir(zip, dist);

const buf = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});
writeFileSync(zipPath, buf);

console.log(`[pack] 打包完成：${zipPath} (${(buf.length / 1024).toFixed(1)} KB)`);
