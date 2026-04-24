#!/usr/bin/env node
/**
 * 把 public/ 目录下的 manifest.json、icons、静态 HTML 引用的资源
 * 复制到 dist/，保证装载到浏览器时路径一致。
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcDir = join(root, "public");
const dstDir = join(root, "dist");

if (!existsSync(srcDir)) {
  console.warn("[copy-public] public/ 不存在，跳过");
  process.exit(0);
}
if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

function walk(from, to) {
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dst = join(to, entry);
    const st = statSync(src);
    if (st.isDirectory()) {
      if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
      walk(src, dst);
    } else {
      copyFileSync(src, dst);
    }
  }
}
walk(srcDir, dstDir);

// vite 把 HTML entry 输出到 dist/src/popup/index.html 这种位置。
// 我们希望 manifest 里的 popup/index.html 指向 dist/popup/index.html。
// 这一步由 vite 的 input 配置 + output.assetFileNames 控制，不在这里处理。

console.log("[copy-public] 已复制 public/ → dist/");
