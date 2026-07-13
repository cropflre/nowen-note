#!/usr/bin/env node
/**
 * 后端生产构建：用 esbuild 把整个后端打成单文件 dist/index.js
 *
 * 目的：把 100MB+ 的 backend/node_modules 砍成只剩真正必须保留为 external 的包，
 * 显著减少 Electron 安装包体积。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = join(__dirname, "dist");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const external = [
  "better-sqlite3",
  "sqlite-vec",
  "sqlite-vec-windows-x64",
  "sqlite-vec-darwin-x64",
  "sqlite-vec-darwin-arm64",
  "sqlite-vec-linux-x64",
  "bonjour-service",
  "unpdf",
  "@aws-sdk/client-s3",
];

const start = Date.now();
await build({
  entryPoints: [join(__dirname, "src", "index.hardened.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: join(outdir, "index.js"),
  external,
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  logOverride: {
    "unsupported-dynamic-import": "silent",
    "unsupported-require-call": "silent",
  },
});

const ms = Date.now() - start;
console.log(`[backend bundle] done in ${ms}ms -> ${join(outdir, "index.js")}`);
console.log(`[backend bundle] external: ${external.join(", ")}`);
