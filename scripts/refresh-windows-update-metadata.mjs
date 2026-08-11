#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { refreshWindowsUpdateMetadata } = require("./lib/refresh-windows-update-metadata.cjs");

function parseArgs(argv) {
  const allowed = new Set(["--metadata", "--asset-dir", "--channel", "--version"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`duplicate argument: ${key}`);
    values[key] = value;
    index += 1;
  }
  for (const key of allowed) {
    if (!values[key]) throw new Error(`missing required argument: ${key}`);
  }
  return values;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const metadataPath = path.resolve(args["--metadata"]);
  const assetDir = path.resolve(args["--asset-dir"]);
  if (!fs.existsSync(metadataPath)) throw new Error(`metadata path does not exist: ${metadataPath}`);
  if (!fs.existsSync(assetDir)) throw new Error(`asset directory does not exist: ${assetDir}`);

  const result = refreshWindowsUpdateMetadata({
    metadataPath,
    assetDir,
    channel: args["--channel"],
    expectedVersion: args["--version"],
  });
  console.log(
    `[windows-update] channel=${result.channel} metadata=${path.basename(result.metadataPath)} exe=${path.basename(result.executablePath)} size=${result.size} sha512=${result.sha512.slice(0, 12)}`,
  );
} catch (error) {
  console.error(`[windows-update] ${error.message}`);
  process.exitCode = 1;
}
