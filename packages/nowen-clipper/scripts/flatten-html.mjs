#!/usr/bin/env node
/**
 * Vite 会把 HTML 入口输出到 dist/src/popup/index.html 这种路径（保留源目录），
 * 而 manifest 里写的是 popup/index.html。本脚本把它们"扁平化"到 dist/ 下的
 * 对应子目录，同时修正 HTML 里对 CSS / JS 的相对引用。
 */
import {
  existsSync, mkdirSync, readdirSync, statSync, copyFileSync,
  readFileSync, writeFileSync, rmSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "dist");
const srcDir = join(dist, "src");

if (!existsSync(srcDir)) {
  console.warn("[flatten-html] 未发现 dist/src/，跳过");
  process.exit(0);
}

// 把 dist/src/popup/* 和 dist/src/options/* 复制到 dist/popup/* 和 dist/options/*
const mappings = [
  { from: join(srcDir, "popup"), to: join(dist, "popup") },
  { from: join(srcDir, "options"), to: join(dist, "options") },
];

for (const { from, to } of mappings) {
  if (!existsSync(from)) continue;
  if (!existsSync(to)) mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const a = join(from, entry);
    const b = join(to, entry);
    const st = statSync(a);
    if (st.isFile()) copyFileSync(a, b);
  }
}

// 删除 dist/src 防止残留
rmSync(srcDir, { recursive: true, force: true });

console.log("[flatten-html] dist/src/* 已扁平化到 dist/popup|options/*");
