#!/usr/bin/env node
/**
 * 后端生产构建：用 esbuild 把整个后端打成单文件 dist/index.js
 *
 * 目的：把 100MB+ 的 backend/node_modules 砍成只剩 4 个真正必须保留为 external 的包，
 * 显著减少 electron 安装包体积（实测 -55MB 解压 / -25MB 压缩）。
 *
 * external 名单（必须保留为 external 的原因）：
 *   - better-sqlite3            含原生 .node，必须 require 真实文件
 *   - sqlite-vec / sqlite-vec-windows-x64 / sqlite-vec-darwin-* / sqlite-vec-linux-*
 *                               平台相关二进制 .so/.dylib/.dll，runtime 探测路径
 *   - bonjour-service           含 multicast-dns 等动态加载的 native-ish 行为
 *   - unpdf                     纯 ESM 包，内含 pdf.js worker / 字体等资源，
 *                               业务侧已用 `await import("unpdf")` 动态加载，
 *                               external 后由运行时 node_modules 直接解析
 *
 * 其他业务依赖（hono, ws, jsonwebtoken, mammoth, jszip, yjs, zod 等）全部 inline 进 bundle。
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = join(__dirname, "dist");

// 干净起步，避免上次 tsc 残留的 d.ts 等无关产物混在里面
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
  // unzipper 的 S3_v3 辅助函数里有可选 AWS SDK require；思源导入只用本地文件。
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
  // 业务里有 require('uuid') 等 ESM 包，esbuild 自动转
  // 保留代码可读性：不 minify（minify 会让生产环境的报错栈非常难看，体积收益也有限）
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  // hono / mammoth 等依赖里偶有 dynamic require，需要明确告诉 esbuild 不要警告
  // （这些都是按需加载，不影响主流程）
  logOverride: {
    "unsupported-dynamic-import": "silent",
    "unsupported-require-call": "silent",
  },
});

const ms = Date.now() - start;
console.log(`[backend bundle] done in ${ms}ms -> ${join(outdir, "index.js")}`);
console.log(`[backend bundle] external: ${external.join(", ")}`);
