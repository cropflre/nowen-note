#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateWindowsSignatures } = require("./lib/windows-signature-validator.cjs");

function parseArgs(argv) {
  const allowed = new Set(["--report", "--publisher", "--require"]);
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
  const reportPath = path.resolve(args["--report"]);
  if (!fs.existsSync(reportPath) || !fs.statSync(reportPath).isFile()) {
    throw new Error(`signature report does not exist: ${reportPath}`);
  }
  const records = JSON.parse(fs.readFileSync(reportPath, "utf8").replace(/^\uFEFF/, ""));
  const requiredChannels = args["--require"].split(",").map((value) => value.trim()).filter(Boolean);
  const result = validateWindowsSignatures(records, {
    expectedPublisher: args["--publisher"],
    requiredChannels,
    now: new Date(),
  });

  for (const record of result.records) {
    console.log(
      `[windows-signature] file=${record.fileName} status=${record.status} cn=${record.signerCommonName} thumbprint=${record.thumbprint}`,
    );
  }
  console.log(`[windows-signature] verified ${result.records.length} executable(s); required=${result.requiredChannels.join(",")}`);
} catch (error) {
  console.error(`[windows-signature] ${error.message}`);
  process.exitCode = 1;
}
