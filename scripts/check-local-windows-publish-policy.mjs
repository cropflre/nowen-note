#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  evaluateLocalWindowsPublishPolicy,
} = require("./lib/local-windows-publish-policy.cjs");

function parseArgs(argv) {
  const allowed = new Set(["--targets", "--pc-platforms", "--host", "--github-release"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key)) throw new Error(`unknown argument: ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    if (Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`duplicate argument: ${key}`);
    values[key] = value;
    index += 1;
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`missing required argument: ${key}`);
  }
  if (!/^[01]$/.test(values["--github-release"])) {
    throw new Error("--github-release must be 0 or 1");
  }
  return values;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = evaluateLocalWindowsPublishPolicy({
    targets: args["--targets"],
    pcPlatforms: args["--pc-platforms"],
    host: args["--host"],
    githubRelease: args["--github-release"] === "1",
  });
  if (!result.allowed) {
    console.error(`[release-policy] ${result.reason}`);
    process.exitCode = 1;
  } else {
    console.log(`[release-policy] allowed: ${result.reason}`);
  }
} catch (error) {
  console.error(`[release-policy] ${error.message}`);
  process.exitCode = 1;
}
