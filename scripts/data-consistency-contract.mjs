#!/usr/bin/env node
/**
 * Nowen Note Data Consistency Contract gate.
 *
 * One source of truth: docs/architecture/data-consistency-contract.matrix.json.
 * --verify fails if a contract case disappears or is silently renamed.
 * --backend / --frontend execute the REAL regression suites referenced by the
 * matrix, not a static source-code grep dressed up as a test.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = path.join(root, "docs/architecture/data-consistency-contract.matrix.json");
const documentPath = path.join(root, "docs/architecture/data-consistency-contract.md");
const argumentsSet = new Set(process.argv.slice(2));
const supported = ["--verify", "--backend", "--frontend", "--all"];
if ([...argumentsSet].some((arg) => !supported.includes(arg)) || argumentsSet.size === 0) {
  console.error("Usage: node scripts/data-consistency-contract.mjs --verify | --backend | --frontend | --all");
  process.exitCode = 2;
} else {
  const failures = [];
  const manifest = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
  const document = fs.readFileSync(documentPath, "utf8");
  const ids = new Set();
  const backendFiles = new Set();
  const frontendFiles = new Set();
  const realTestCases = new Set();

  for (const policy of manifest.policies || []) {
    if (!/^DCC-\d{3}$/.test(policy.id) || ids.has(policy.id)) {
      failures.push("Invalid or repeated contract ID: " + policy.id);
    }
    ids.add(policy.id);
    if (!document.includes(policy.id)) {
      failures.push("Contract documentation is missing " + policy.id);
    }
    if (!Array.isArray(policy.checks) || policy.checks.length === 0) {
      failures.push(policy.id + " has no executable regression cases");
      continue;
    }
    if (policy.status !== "covered") {
      failures.push(policy.id + " is in the executable contract but is not marked covered");
    }
    for (const check of policy.checks) {
      if (typeof check.file !== "string" || typeof check.case !== "string" ||
          check.case.length < 12 || !/^(frontend\/src\/lib\/__tests__|backend\/tests)\/[\w./-]+\.test\.tsx?$/.test(check.file)) {
        failures.push(policy.id + " uses an invalid test path/case: " + JSON.stringify(check));
        continue;
      }
      const fullPath = path.resolve(root, check.file);
      if (!fullPath.startsWith(root + path.sep)) {
        failures.push("Test path escaped repository root: " + check.file);
        continue;
      }
      if (!fs.existsSync(fullPath)) {
        failures.push(policy.id + " references missing test file " + check.file);
        continue;
      }
      const source = fs.readFileSync(fullPath, "utf8");
      // Test titles are actual cases (it/test), not merely comments or docs.
      // Prefix permits deliberate partial titles, while still detecting deleted
      // or renamed tests before the CI runner is invoked.
      const found = source.split("\n").some((line) =>
        /^\s*(?:test|it)(?:\.skip|\.only|\.todo)?\(\s*["'`]/.test(line) &&
        line.includes(check.case) && !/\.skip\(|\.todo\(/.test(line),
      );
      if (!found) {
        failures.push(policy.id + ": missing/disabled live test case: " + check.file + " :: " + check.case);
      }
      realTestCases.add(check.file + " :: " + check.case);
      if (check.file.startsWith("backend/")) backendFiles.add(check.file.slice("backend/".length));
      else frontendFiles.add(check.file.slice("frontend/".length));
    }
  }
  if (manifest.version !== 1 || ids.size < 8 || backendFiles.size < 4 || frontendFiles.size < 4) {
    failures.push("Contract manifest is incomplete: expected v1 with 8+ invariants and both runtime test suites");
  }
  if (failures.length) {
    for (const failure of failures) console.error("[data-consistency] FAIL:", failure);
    process.exitCode = 1;
  } else {
    console.log("[data-consistency] verified", ids.size, "invariants /", realTestCases.size,
      "test references /", backendFiles.size, "backend files /", frontendFiles.size, "frontend files");

    const run = (command, args, cwd) => {
      console.log("[data-consistency] running:", command, ...args);
      const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        console.error("[data-consistency] regression suite failed:", command, args.join(" "));
        process.exit(result.status || 1);
      }
    };

    const backend = argumentsSet.has("--backend") || argumentsSet.has("--all");
    const frontend = argumentsSet.has("--frontend") || argumentsSet.has("--all");
    // Run each backend integration suite in its own process to avoid sharing
    // an implicit SQLite singleton or DB_PATH between unrelated test fixtures.
    if (backend) {
      for (const file of [...backendFiles].sort()) {
        run(process.execPath, ["--import", "tsx", "--test", file], path.join(root, "backend"));
      }
    }
    // Vitest isolates modules/globals per test file. Give it one test run so
    // a large suite doesn't spawn the Vite compiler for every single case.
    if (frontend) {
      run(process.platform === "win32" ? "npx.cmd" : "npx",
        ["vitest", "run", ...[...frontendFiles].sort(), "--reporter=verbose"],
        path.join(root, "frontend"));
    }
  }
}
