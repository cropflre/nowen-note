#!/usr/bin/env node
/**
 * 后端生产构建：用 esbuild 把整个后端打成单文件 dist/index.js。
 * PostgreSQL schema 与版本化 migration 是运行时资源，构建后复制到
 * dist/postgres，避免开发环境可用而生产镜像启动失败。
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";

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

const postgresSourceDir = join(__dirname, "src", "db", "postgres");
const postgresOutputDir = join(outdir, "postgres");
const migrationsSourceDir = join(postgresSourceDir, "migrations");
const migrationsOutputDir = join(postgresOutputDir, "migrations");
mkdirSync(migrationsOutputDir, { recursive: true });
copyFileSync(join(postgresSourceDir, "schema.sql"), join(postgresOutputDir, "schema.sql"));
copyFileSync(join(postgresSourceDir, "schema.base.sql"), join(postgresOutputDir, "schema.base.sql"));
for (const file of readdirSync(migrationsSourceDir)) {
  if (!file.endsWith(".sql")) continue;
  copyFileSync(join(migrationsSourceDir, file), join(migrationsOutputDir, file));
}

const ms = Date.now() - start;
console.log(`[backend bundle] done in ${ms}ms -> ${join(outdir, "index.js")}`);
console.log(`[backend bundle] external: ${external.join(", ")}`);
console.log(`[backend bundle] PostgreSQL resources -> ${postgresOutputDir}`);
