#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const equalIndex = arg.indexOf("=");
    if (equalIndex > 0) {
      values[arg.slice(2, equalIndex)] = arg.slice(equalIndex + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[arg.slice(2)] = next;
      index += 1;
    } else {
      values[arg.slice(2)] = "true";
    }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const targetPlatform = args["target-platform"] || process.env.TARGET_PLATFORM || process.platform;
const targetArch = args["target-arch"] || process.env.TARGET_ARCH || process.env.npm_config_target_arch || process.arch;
const inBaselineContainer = process.env.NOWEN_LINUX_BASELINE_CONTAINER === "1";
const portableRequested =
  process.env.NOWEN_LINUX_PORTABLE === "1" ||
  process.env.CI === "true" ||
  process.env.GITHUB_ACTIONS === "true";

if (
  targetPlatform === "linux" &&
  process.platform === "linux" &&
  portableRequested &&
  !inBaselineContainer
) {
  const result = spawnSync("bash", [path.join(root, "scripts", "rebuild-linux-portable.sh")], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      TARGET_ARCH: targetArch,
    },
  });
  process.exit(result.status ?? 1);
}

await import("./rebuild-native.mjs");
