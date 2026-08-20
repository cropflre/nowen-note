#!/usr/bin/env node

/**
 * 逐个运行测试文件，解决 DB_PATH 全局竞争导致的隔离问题。
 *
 * 用法：node scripts/run-tests-serial.mjs
 * 对应 npm script：npm run test:serial
 */

import { readdir } from "node:fs/promises";
import { copyFileSync, readFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testsDir = path.resolve(__dirname, "..", "tests");
const setupFile = path.join(testsDir, "setup-db-isolation.ts");
const DEFAULT_TEST_TIMEOUT_MS = 120_000;

/** 跨平台枚举测试文件，不依赖 shell 对 tests/*.test.ts 的 glob 展开。 */
export async function enumerateTestFiles() {
  const entries = await readdir(testsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

/** 运行单个测试文件，并在超时时终止整个子进程树。 */
export function runTestFile(filePath, label, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const workingDirectory = path.resolve(__dirname, "..");
  const setupArg = `./${toPosixPath(path.relative(workingDirectory, setupFile))}`;
  const sourcePath = path.isAbsolute(filePath) ? filePath : path.resolve(workingDirectory, filePath);
  const needsEsm = /^(?:const|let|var)\s+[^\n]*\bawait\s+import\s*\(/m.test(readFileSync(sourcePath, "utf8"));
  const temporaryPath = needsEsm
    ? path.join(testsDir, `.nowen-run-${process.pid}-${path.basename(filePath, ".test.ts")}.test.mts`)
    : null;
  if (temporaryPath) copyFileSync(sourcePath, temporaryPath);
  const testArg = path.isAbsolute(filePath)
    ? toPosixPath(path.relative(workingDirectory, filePath))
    : toPosixPath(filePath);
  const effectiveTestArg = temporaryPath
    ? toPosixPath(path.relative(workingDirectory, temporaryPath))
    : testArg;

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--import", setupArg, "--test", effectiveTestArg],
      {
        cwd: workingDirectory,
        stdio: ["ignore", "pipe", "pipe"],
        env: withoutNodeTestContext(),
        detached: process.platform !== "win32",
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (temporaryPath) {
        try { unlinkSync(temporaryPath); } catch { /* 子进程可能已清理 */ }
      }
      resolve({ label, stdout, stderr, ...result });
    };

    child.once("error", (error) => {
      finish({
        status: "failed",
        code: null,
        firstError: error instanceof Error ? error.message : String(error),
      });
    });

    child.once("close", (code, signal) => {
      finish({
        status: code === 0 ? "passed" : "failed",
        code,
        signal,
        firstError: code === 0 ? null : findFirstRootError(stderr || stdout),
      });
    });

    timer = setTimeout(() => {
      const message = `timeout after ${timeoutMs}ms`;
      terminateProcessTree(child).finally(() => {
        finish({ status: "timeout", code: null, signal: "SIGTERM", firstError: message });
      });
    }, timeoutMs);
    timer.unref?.();
  });
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function withoutNodeTestContext() {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

function findFirstRootError(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rootError = lines.find((line) =>
    /(?:Error|AssertionError|TypeError|ReferenceError|SyntaxError|ERR_|SQLITE_|not ok|failureType)/i.test(line),
  );
  return rootError || lines[0] || "子进程失败但没有输出错误信息";
}

async function terminateProcessTree(child) {
  if (!child.pid) return;

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("close", resolve);
      killer.once("error", resolve);
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* 子进程可能已退出 */ }
  }
}

export async function runSuite() {
  const files = await enumerateTestFiles();

  if (files.length === 0) {
    console.log("No test files found.");
    return { total: 0, passed: 0, failed: 0, timeout: 0, failures: [] };
  }

  const timeoutMs = Number(process.env.NOWEN_TEST_FILE_TIMEOUT_MS) || DEFAULT_TEST_TIMEOUT_MS;
  console.log(`Running ${files.length} test files serially (timeout ${timeoutMs}ms)...\n`);

  const results = [];
  for (const file of files) {
    const result = await runTestFile(path.join(testsDir, file), file, { timeoutMs });
    results.push(result);
    const icon = result.status === "passed" ? "✓" : result.status === "timeout" ? "⏱" : "✗";
    console.log(`${icon} ${file}`);
    if (result.status !== "passed") {
      console.log(`    root error: ${result.firstError || "unknown error"}`);
    }
  }

  const summary = {
    total: results.length,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    timeout: results.filter((result) => result.status === "timeout").length,
    failures: results.filter((result) => result.status !== "passed"),
  };

  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `Serial test run complete: ${summary.passed} passed, ` +
      `${summary.failed} failed, ${summary.timeout} timeout out of ${summary.total} files.`,
  );

  if (summary.failures.length > 0) {
    console.log("\nFailed files:");
    for (const result of summary.failures) {
      console.log(`  - ${result.label} [${result.status}]: ${result.firstError}`);
    }
  }

  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const summary = await runSuite();
  if (summary.failed > 0 || summary.timeout > 0) process.exitCode = 1;
}
