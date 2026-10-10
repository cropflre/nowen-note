import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(testDir, "..");
const repoRoot = path.resolve(backendDir, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("production bootstrap installs and verifies large ZIP streaming restore before mounting routes", () => {
  const bootstrap = read("backend/src/index.hardened.ts");
  const patchImport = 'import "./runtime/backup-restore-large-archive.js";';
  const guardImport = 'import "./runtime/backup-restore-large-archive-guard.js";';
  const appImport = 'import "./index.js";';

  const patchIndex = bootstrap.indexOf(patchImport);
  const guardIndex = bootstrap.indexOf(guardImport);
  const appIndex = bootstrap.indexOf(appImport);

  assert.notEqual(patchIndex, -1, "hardened bootstrap must install the streaming restore patch");
  assert.notEqual(guardIndex, -1, "hardened bootstrap must verify the streaming restore patch");
  assert.notEqual(appIndex, -1, "hardened bootstrap must mount the main backend app");
  assert.ok(patchIndex < guardIndex, "streaming restore patch must load before its startup guard");
  assert.ok(guardIndex < appIndex, "streaming restore must be verified before backup routes can mount");
});

test("Docker production image starts the hardened backend entrypoint", () => {
  const dockerfile = read("Dockerfile");
  assert.match(
    dockerfile,
    /CMD\s*\["node",\s*"backend\/dist\/index\.hardened\.js"\]/,
    "Docker must start index.hardened.js so multi-GB ZIP restore never falls back to the legacy whole-buffer path",
  );
});
