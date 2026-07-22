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
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (!exited) child.kill();

  assert.equal(exited, false, output);
  assert.doesNotMatch(output, /Cannot read properties of undefined \(reading 'routes'\)/);
  assert.match(output, new RegExp(`OpenAPI 文档: http://localhost:${port}/api/openapi\\.json`));
});
