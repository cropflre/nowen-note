#!/usr/bin/env node

import { brotliCompressSync, gzipSync, constants } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, "../frontend/dist");
const manifestPath = path.join(distDir, ".vite/manifest.json");
const enforce = process.argv.includes("--enforce");

const budgets = {
  initialRequestCount: Number(process.env.NOWEN_MAX_INITIAL_JS_REQUESTS || 16),
  initialRawBytes: Number(process.env.NOWEN_MAX_INITIAL_RAW_BYTES || 4_000_000),
  initialGzipBytes: Number(process.env.NOWEN_MAX_INITIAL_GZIP_BYTES || 1_300_000),
  initialChunkRawBytes: Number(process.env.NOWEN_MAX_INITIAL_CHUNK_RAW_BYTES || 2_000_000),
  initialChunkGzipBytes: Number(process.env.NOWEN_MAX_INITIAL_CHUNK_GZIP_BYTES || 650_000),
};

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

function collectInitialManifestKeys(manifest, entryKey) {
  const visited = new Set();
  const visit = (key) => {
    if (!key || visited.has(key)) return;
    visited.add(key);
    const item = manifest[key];
    for (const importedKey of item?.imports || []) visit(importedKey);
  };
  visit(entryKey);
  return visited;
}

async function measureFile(relativePath) {
  const filePath = path.join(distDir, relativePath);
  const content = await readFile(filePath);
  const gzipBytes = gzipSync(content, { level: 9 }).byteLength;
  const brotliBytes = brotliCompressSync(content, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 7,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    },
  }).byteLength;
  return {
    file: relativePath,
    rawBytes: content.byteLength,
    gzipBytes,
    brotliBytes,
  };
}

function toMarkdown(report) {
  const rows = report.initialFiles
    .map((item) => `| \`${item.file}\` | ${formatBytes(item.rawBytes)} | ${formatBytes(item.gzipBytes)} | ${formatBytes(item.brotliBytes)} |`)
    .join("\n");
  const violations = report.violations.length
    ? report.violations.map((value) => `- ❌ ${value}`).join("\n")
    : "- ✅ Bundle budgets passed";
  return [
    "## Frontend bundle report",
    "",
    `Initial JavaScript: **${report.initialFiles.length} requests / ${formatBytes(report.initialTotals.rawBytes)} raw / ${formatBytes(report.initialTotals.gzipBytes)} gzip / ${formatBytes(report.initialTotals.brotliBytes)} Brotli**`,
    "",
    "| Initial file | Raw | Gzip | Brotli |",
    "| --- | ---: | ---: | ---: |",
    rows || "| _none_ | 0 B | 0 B | 0 B |",
    "",
    "### Budget result",
    violations,
    "",
  ].join("\n");
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = Object.entries(manifest).find(([, value]) => value?.isEntry);
  if (!entry) throw new Error("Vite manifest does not contain an entry chunk");

  const [entryKey] = entry;
  const initialKeys = collectInitialManifestKeys(manifest, entryKey);
  const initialFileNames = Array.from(initialKeys)
    .map((key) => manifest[key]?.file)
    .filter((file) => typeof file === "string" && /\.m?js$/i.test(file));
  const allJavaScriptFileNames = Array.from(new Set(
    Object.values(manifest)
      .map((item) => item?.file)
      .filter((file) => typeof file === "string" && /\.m?js$/i.test(file)),
  ));

  const initialFiles = (await Promise.all(initialFileNames.map(measureFile)))
    .sort((left, right) => right.rawBytes - left.rawBytes);
  const allJavaScriptFiles = (await Promise.all(allJavaScriptFileNames.map(measureFile)))
    .sort((left, right) => right.rawBytes - left.rawBytes);
  const initialTotals = initialFiles.reduce(
    (total, item) => ({
      rawBytes: total.rawBytes + item.rawBytes,
      gzipBytes: total.gzipBytes + item.gzipBytes,
      brotliBytes: total.brotliBytes + item.brotliBytes,
    }),
    { rawBytes: 0, gzipBytes: 0, brotliBytes: 0 },
  );

  const violations = [];
  if (initialFiles.length > budgets.initialRequestCount) {
    violations.push(`initial JS requests ${initialFiles.length} exceed ${budgets.initialRequestCount}`);
  }
  if (initialTotals.rawBytes > budgets.initialRawBytes) {
    violations.push(`initial JS raw ${formatBytes(initialTotals.rawBytes)} exceeds ${formatBytes(budgets.initialRawBytes)}`);
  }
  if (initialTotals.gzipBytes > budgets.initialGzipBytes) {
    violations.push(`initial JS gzip ${formatBytes(initialTotals.gzipBytes)} exceeds ${formatBytes(budgets.initialGzipBytes)}`);
  }
  for (const item of initialFiles) {
    if (item.rawBytes > budgets.initialChunkRawBytes) {
      violations.push(`${item.file} raw ${formatBytes(item.rawBytes)} exceeds ${formatBytes(budgets.initialChunkRawBytes)}`);
    }
    if (item.gzipBytes > budgets.initialChunkGzipBytes) {
      violations.push(`${item.file} gzip ${formatBytes(item.gzipBytes)} exceeds ${formatBytes(budgets.initialChunkGzipBytes)}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    entryKey,
    budgets,
    initialTotals,
    initialFiles,
    largestJavaScriptFiles: allJavaScriptFiles.slice(0, 20),
    violations,
  };
  await writeFile(
    path.join(distDir, "bundle-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  console.log("\n[frontend bundle] initial JavaScript");
  console.table(initialFiles.map((item) => ({
    file: item.file,
    raw: formatBytes(item.rawBytes),
    gzip: formatBytes(item.gzipBytes),
    brotli: formatBytes(item.brotliBytes),
  })));
  console.log(
    `[frontend bundle] total: ${initialFiles.length} requests / ${formatBytes(initialTotals.rawBytes)} raw / ${formatBytes(initialTotals.gzipBytes)} gzip / ${formatBytes(initialTotals.brotliBytes)} br`,
  );

  const markdown = toMarkdown(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: "a" });
  }

  if (violations.length) {
    for (const violation of violations) console.error(`[frontend bundle] budget exceeded: ${violation}`);
    if (enforce) process.exitCode = 1;
  } else {
    console.log("[frontend bundle] budgets passed");
  }
}

main().catch((error) => {
  console.error("[frontend bundle] analysis failed", error);
  process.exitCode = 1;
});
