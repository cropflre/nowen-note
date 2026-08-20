import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("hardened backend entrypoint initializes the attachment router", async () => {
  const port = "38427";
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.hardened.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", PORT: port },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const readyPattern = new RegExp(`OpenAPI 文档: http://localhost:${port}/api/openapi\\.json`);
  let markReady = () => {};
  const ready = new Promise<"ready">((resolve) => {
    markReady = () => resolve("ready");
  });
  const appendOutput = (chunk: Buffer) => {
    output += chunk.toString();
    if (readyPattern.test(output)) markReady();
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);

  let timeout: NodeJS.Timeout;
  const outcome = await Promise.race([
    ready,
    new Promise<"exited">((resolve) => child.once("exit", () => resolve("exited"))),
    new Promise<"timeout">((resolve) => { timeout = setTimeout(() => resolve("timeout"), 15_000); }),
  ]);
  clearTimeout(timeout!);
  if (child.exitCode === null) {
    child.kill();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }

  assert.equal(outcome, "ready", output);
  assert.doesNotMatch(output, /Cannot read properties of undefined \(reading 'routes'\)/);
  assert.match(output, readyPattern);
});
