#!/usr/bin/env node

import { brotliCompress, gzip } from "node:zlib";
import { constants } from "node:zlib";
import { promisify } from "node:util";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, "../frontend/dist");
const MIN_BYTES = Number(process.env.NOWEN_PRECOMPRESS_MIN_BYTES || 1024);
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".txt",
  ".wasm",
  ".xml",
]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(filePath));
    else if (entry.isFile()) files.push(filePath);
  }
  return files;
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

async function main() {
  const distStat = await stat(distDir).catch(() => null);
  if (!distStat?.isDirectory()) {
    throw new Error(`frontend dist directory not found: ${distDir}`);
  }

  const sourceFiles = (await walk(distDir)).filter((filePath) => {
    if (filePath.endsWith(".br") || filePath.endsWith(".gz")) return false;
    return COMPRESSIBLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  });

  let sourceBytes = 0;
  let brotliBytes = 0;
  let gzipBytes = 0;
  let generated = 0;

  for (const filePath of sourceFiles) {
    const input = await readFile(filePath);
    if (input.byteLength < MIN_BYTES) continue;

    const [brotliOutput, gzipOutput] = await Promise.all([
      brotliCompressAsync(input, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 9,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        },
      }),
      gzipAsync(input, { level: 9 }),
    ]);

    await Promise.all([
      writeFile(`${filePath}.br`, brotliOutput),
      writeFile(`${filePath}.gz`, gzipOutput),
    ]);

    sourceBytes += input.byteLength;
    brotliBytes += brotliOutput.byteLength;
    gzipBytes += gzipOutput.byteLength;
    generated += 1;
  }

  console.log(`[frontend precompress] ${generated} assets`);
  if (generated > 0) {
    console.log(
      `[frontend precompress] source ${formatBytes(sourceBytes)} -> br ${formatBytes(brotliBytes)} (${Math.round((brotliBytes / sourceBytes) * 100)}%) / gzip ${formatBytes(gzipBytes)} (${Math.round((gzipBytes / sourceBytes) * 100)}%)`,
    );
  }
}

main().catch((error) => {
  console.error("[frontend precompress] failed", error);
  process.exitCode = 1;
});
