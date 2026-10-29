import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import test from "node:test";
import jwt from "jsonwebtoken";

test("production HTTP auth rejects forged token scopes and machine approval, then imports with a real session", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-migration-http-"));
  const secret = "isolated-migration-http-fixture-secret";
  Object.assign(process.env, { NODE_ENV: "test", DB_PATH: path.join(directory, "test.db"), ELECTRON_USER_DATA: directory, JWT_SECRET: secret });
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  const schema = await import("../src/db/schema");
  const tokens = await import("../src/lib/api-tokens");
  const db = schema.getDb(); tokens.initApiTokensTable(db);
  for (const id of ["http-owner", "http-other"]) {
    db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'fixture')").run(id, id);
    db.prepare("INSERT INTO user_sessions(id,userId,expiresAt) VALUES (?,?,?)").run(`${id}-session`, id, new Date(Date.now() + 3_600_000).toISOString());
  }
  const emptyToken = tokens.generateApiTokenRaw(), token = tokens.generateApiTokenRaw();
  for (const [raw, scopes] of [[emptyToken, []], [token, ["export:import", "notes:read", "notes:write", "notebooks:write"]]] as const) {
    db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes) VALUES (?,'http-owner','fixture',?,?)").run(crypto.randomUUID(), tokens.hashApiToken(raw), JSON.stringify(scopes));
  }
  schema.closeDb();
  const port = await new Promise<number>((resolve) => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address() as net.AddressInfo; server.close(() => resolve(address.port)); }); });
  const environment = { ...process.env, PORT: String(port) }; delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", "tsx", path.resolve(__dirname, "../src/index.hardened.ts")], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { output += data; });
  const base = `http://127.0.0.1:${port}/api`;
  const login = (userId: string) => jwt.sign({ userId, tver: 0, jti: `${userId}-session` }, secret, { expiresIn: "1h" });
  const owner = login("http-owner"), other = login("http-other");
  const request = async (url: string, bearer?: string, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(base + url, { method: body === undefined ? "GET" : "POST", headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), "Content-Type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const deadline = Date.now() + 20_000;
    while (true) {
      try { if ((await fetch(base + "/health")).ok) break; } catch { /* startup */ }
      assert.ok(Date.now() < deadline && child.exitCode === null, output.slice(-3000));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await request("/migrations")).status, 401);
    const denied = await request("/migrations", emptyToken, undefined, { "X-Api-Scopes": "export:import,notes:read,notes:write,notebooks:write", "X-User-Id": "http-other" });
    assert.equal(denied.status, 403); assert.equal(denied.body.code, "API_TOKEN_SCOPE_REQUIRED");
    const source = { platform: "markdown", exportId: "http-export" };
    const created = await request("/migrations", token, { operationId: crypto.randomUUID(), source, name: "HTTP migration" });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal((await request(`/migrations/${id}`, other)).status, 404);
    assert.equal((await request(`/migrations/${id}/items`, token, { items: [{ schemaVersion: 1, source: { ...source, sourceId: "http-note" }, title: "HTTP Note", contentFormat: "markdown", content: "# HTTP body" }] })).status, 200);
    const preview = await request(`/migrations/${id}/preview`, token, {}); assert.equal(preview.status, 200);
    assert.equal((await request(`/migrations/${id}/approve`, token, { previewDigest: preview.body.previewDigest }, { "X-Session-Id": "http-owner-session", "X-Auth-Mode": "login" })).status, 403);
    assert.equal((await request(`/migrations/${id}/approve`, owner, { previewDigest: preview.body.previewDigest }, { "X-Auth-Mode": "api-token", "X-Api-Token-Id": "forged" })).status, 202);
    const end = Date.now() + 10_000;
    let current;
    do { current = await request(`/migrations/${id}`, owner); if (current.body.status === "COMPLETED") break; await new Promise((resolve) => setTimeout(resolve, 50)); } while (Date.now() < end);
    assert.equal(current.body.status, "COMPLETED", JSON.stringify(current.body));
    assert.equal(current.body.counts.imported, 1);
    assert.ok(!JSON.stringify(current.body).includes("HTTP body"));
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(null); else child.once("close", resolve); });
    schema.closeDb(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
