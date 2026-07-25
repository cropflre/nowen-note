import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("standard backend entry installs the knowledge tree routes", () => {
  const source = readFileSync("src/index.ts", "utf8");
  const migrationBootstrap = source.indexOf('import "./runtime/knowledge-tree-migration-bootstrap"');
  const knowledgeTreeRuntime = source.indexOf('import "./runtime/knowledge-tree"');
  const knowledgeTreeRoute = source.indexOf('app.route("/api/knowledge-tree/", knowledgeTreeRouter)');

  assert.ok(migrationBootstrap >= 0);
  assert.ok(knowledgeTreeRuntime >= 0);
  assert.ok(knowledgeTreeRoute >= 0);
  assert.ok(migrationBootstrap < knowledgeTreeRuntime);
});

test("standard backend entry serves both knowledge tree listings", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "nowen-knowledge-tree-entry-"));
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_PATH: path.join(tempDir, "knowledge-tree-entry.db"),
      NODE_ENV: "test",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(ready, true, output);

    const registration = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "routecheck", password: "routecheck-pass" }),
    });
    const registrationBody = await registration.text();
    assert.equal(registration.status, 201, registrationBody);
    const { token } = JSON.parse(registrationBody) as { token: string };

    for (const requestPath of [
      "/api/knowledge-tree/?workspaceId=personal",
      "/api/knowledge-tree/shared-with-me?workspaceId=personal",
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200, `${requestPath}: ${await response.text()}`);
    }
  } finally {
    child.kill();
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
