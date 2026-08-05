import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  EXIT_CODES,
  parseHeartbeatMs,
  validateRuntimeConfig,
} from "../bin/runtime-diagnostics.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = path.join(packageRoot, "bin", "nowen-mcp.mjs");
const runtimePath = path.join(packageRoot, "bin", "runtime-diagnostics.mjs");

function cleanEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.NOWEN_API_TOKEN;
  delete env.NOWEN_USERNAME;
  delete env.NOWEN_PASSWORD;
  return env;
}

function parseStructuredEvents(stderr) {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("[nowen-mcp] "))
    .map((line) => JSON.parse(line.slice("[nowen-mcp] ".length)));
}

function runToExit(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process timeout: ${stderr}`));
    }, options.timeoutMs ?? 8_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function makeIsolatedLauncher() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nowen-mcp-launcher-"));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await copyFile(launcherPath, path.join(bin, "nowen-mcp.mjs"));
  await copyFile(runtimePath, path.join(bin, "runtime-diagnostics.mjs"));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  return root;
}

test("heartbeat is disabled by default and validates explicit intervals", () => {
  assert.equal(parseHeartbeatMs(undefined), 0);
  assert.equal(parseHeartbeatMs("off"), 0);
  assert.equal(parseHeartbeatMs("300000"), 300000);
  assert.throws(() => parseHeartbeatMs("5000"), /10000/);
});

test("runtime config rejects unsupported URL protocols before loading the entry", () => {
  assert.throws(
    () => validateRuntimeConfig({
      env: { NOWEN_URL: "file:///tmp/nowen" },
      nodeVersion: "24.15.0",
    }),
    (error) => error?.code === "INVALID_NOWEN_URL_PROTOCOL",
  );
});

test("missing dist entry reports a friendly actionable stderr error", async () => {
  const isolatedRoot = await makeIsolatedLauncher();
  try {
    const result = await runToExit(
      process.execPath,
      [path.join(isolatedRoot, "bin", "nowen-mcp.mjs")],
      {
        cwd: os.tmpdir(),
        env: cleanEnv({ NOWEN_URL: "http://127.0.0.1:3001" }),
      },
    );
    assert.equal(result.code, EXIT_CODES.ENTRY_NOT_FOUND);
    assert.equal(result.stdout, "");
    const events = parseStructuredEvents(result.stderr);
    const failure = events.find((event) => event.event === "startup_failed");
    assert.equal(failure?.code, "ENTRY_NOT_FOUND");
    assert.match(failure?.suggestion ?? "", /npm install && npm run build/);
    assert.match(failure?.message ?? "", /dist[\\/]scoped-entry\.js/);
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
});

test("missing runtime dependency is distinguished from a missing entry", async () => {
  const isolatedRoot = await makeIsolatedLauncher();
  try {
    const dist = path.join(isolatedRoot, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(
      path.join(dist, "scoped-entry.js"),
      'import "nowen-mcp-test-dependency-that-does-not-exist";\n',
    );
    const result = await runToExit(
      process.execPath,
      [path.join(isolatedRoot, "bin", "nowen-mcp.mjs")],
      {
        cwd: os.tmpdir(),
        env: cleanEnv({ NOWEN_URL: "http://127.0.0.1:3001" }),
      },
    );
    assert.equal(result.code, EXIT_CODES.SOFTWARE);
    assert.equal(result.stdout, "");
    const events = parseStructuredEvents(result.stderr);
    const failure = events.find((event) => event.event === "startup_failed");
    assert.equal(failure?.code, "DEPENDENCY_NOT_FOUND");
    assert.ok(failure?.error?.stack);
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
});

test("launcher starts from an arbitrary cwd, keeps stdout clean, and explains stdin shutdown", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "nowen-mcp-cwd-"));
  const child = spawn(process.execPath, [launcherPath], {
    cwd,
    env: cleanEnv({
      NOWEN_URL: "http://127.0.0.1:3001",
      NOWEN_MCP_HEARTBEAT_MS: "0",
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`startup_ready timeout: ${stderr}`));
      }, 8_000);
      const inspect = () => {
        const ready = parseStructuredEvents(stderr)
.some((event) => event.event === "startup_ready");
        if (ready) {
clearTimeout(timer);
child.stderr.off("data", inspect);
resolve();
        }
      };
      child.stderr.on("data", inspect);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`process exited before ready: code=${code} signal=${signal} ${stderr}`));
      });
      inspect();
    });

    assert.equal(stdout, "");
    assert.equal(child.exitCode, null);
    child.stdin.end();
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`stdin shutdown timeout: ${stderr}`));
      }, 8_000);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.equal(stdout, "");
    const events = parseStructuredEvents(stderr);
    assert.ok(events.some((event) => event.event === "startup_ready"));
    assert.ok(events.some((event) => event.event === "stdin_closed"));
    assert.ok(events.some((event) => event.event === "process_exit"));
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(cwd, { recursive: true, force: true });
  }
});
