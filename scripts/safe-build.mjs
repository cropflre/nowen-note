#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const staleWorkspaceOutput = join(repoRoot, "dist-electron");

if (existsSync(staleWorkspaceOutput)) {
  console.log(`[safe-build] removing stale workspace output -> ${staleWorkspaceOutput}`);
  rmSync(staleWorkspaceOutput, { recursive: true, force: true });
}

const result = spawnSync(process.execPath, [join(scriptDir, "safe-build-legacy.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
