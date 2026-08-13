#!/usr/bin/env node

/**
 * 逐个运行测试文件，解决 DB_PATH 全局竞争导致的隔离问题。
 *
 * 用法：node scripts/run-tests-serial.mjs
 * 对应 npm script：npm run test:serial
 */

import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.resolve(__dirname, "..", "tests");

async function main() {
  const files = (await readdir(testsDir))
    .filter((f) => f.endsWith(".test.ts"))
    .sort();

  if (files.length === 0) {
    console.log("No test files found.");
    process.exit(0);
  }

  console.log(`Running ${files.length} test files serially...\n`);

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const file of files) {
    const filePath = path.join(testsDir, file);
    const ok = await runTest(filePath, file);
    if (ok) {
      passed++;
    } else {
      failed++;
      failures.push(file);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Serial test run complete: ${passed} passed, ${failed} failed out of ${files.length} files.`);

  if (failures.length > 0) {
    console.log("\nFailed files:");
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exit(1);
  }
}

function runTest(filePath, label) {
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", "--import", "./tests/setup-db-isolation.ts", "--test", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      const ok = code === 0;
      const icon = ok ? "✓" : "✗";
      console.log(`${icon} ${label}`);
      if (!ok) {
        // TAP headers and migration notices are normally at the beginning. The tail contains the
        // failed assertion, stack and test summary, so print that instead of the first five lines.
        const lines = (stderr || stdout).split("\n").filter(Boolean);
        for (const line of lines.slice(-40)) {
          console.log(`    ${line}`);
        }
      }
      resolve(ok);
    });
  });
}

main();
