#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  validateSignPathReleaseConfig,
} = require("./lib/signpath-release-config.cjs");

const result = validateSignPathReleaseConfig(process.env);
if (!result.ok) {
  console.error(`[signpath] missing configuration: ${result.missing.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`[signpath] configured: ${result.configured.join(", ")}`);
  if (result.publisherBootstrapRequired) {
    console.log("[signpath] publisher bootstrap: release-signing requests may proceed; formal artifact upload and publication will stop until NOWEN_WINDOWS_PUBLISHER_NAME is confirmed");
  }
}
