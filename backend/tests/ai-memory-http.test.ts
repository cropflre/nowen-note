import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import test from "node:test";
import jwt from "jsonwebtoken";

test("production HTTP archive authentication ignores forged identity and enforces notebook token scopes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-ai-archive-http-")), secret = "isolated-ai-archive-http-fixture-secret";
  Object.assign(process.env, { NODE_ENV: "test", DB_PATH: path.join(directory, "test.db"), ELECTRON_USER_DATA: directory, JWT_SECRET: secret });
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  const schema = await import("../src/db/schema"), tokens = await import("../src/lib/api-tokens");
  const db = schema.getDb(); tokens.initApiTokensTable(db);
  for (const user of ["archive-http-owner", "archive-http-other", "archive-http-admin"]) {
    db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'fixture')").run(user, user);
    db.prepare("INSERT INTO user_sessions(id,userId,expiresAt) VALUES (?,?,?)").run(`${user}-session`, user, new Date(Date.now() + 3_600_000).toISOString());
  }
  db.prepare("UPDATE users SET role='admin' WHERE id='archive-http-admin'").run();
  for (const notebook of ["archive-http-granted", "archive-http-other-notebook"]) db.prepare("INSERT INTO notebooks(id,userId,name) VALUES (?,'archive-http-owner',?)").run(notebook, notebook);
  const scoped = tokens.generateApiTokenRaw(), empty = tokens.generateApiTokenRaw(), readOnly = tokens.generateApiTokenRaw();
  for (const [id, raw, scopes, mode] of [
    ["archive-http-token", scoped, ["notes:read", "notes:write"], "restricted"],
    ["archive-http-empty", empty, [], "unrestricted"],
    ["archive-http-readonly", readOnly, ["notes:read"], "unrestricted"],
  ] as const) db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes,resourceMode) VALUES (?,'archive-http-owner','fixture',?,?,?)").run(id, tokens.hashApiToken(raw), JSON.stringify(scopes), mode);
  db.prepare("INSERT INTO api_token_resources(tokenId,resourceType,resourceId,permission,includeDescendants) VALUES ('archive-http-token','notebook','archive-http-granted','write',0)").run();
  schema.closeDb();
  const port = await new Promise<number>((resolve) => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address() as net.AddressInfo; server.close(() => resolve(address.port)); }); });
  const environment = { ...process.env, PORT: String(port) }; delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", "tsx", path.resolve(__dirname, "../src/index.hardened.ts")], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { output += data; });
  const base = `http://127.0.0.1:${port}/api/ai-memory`;
  const login = (userId: string) => jwt.sign({ userId, tver: 0, jti: `${userId}-session` }, secret, { expiresIn: "1h" });
  const request = async (url: string, bearer?: string, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(base + url, { method: body === undefined ? "GET" : "POST", headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), "Content-Type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const deadline = Date.now() + 20_000;
    while (true) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* startup */ }
      assert.ok(Date.now() < deadline && child.exitCode === null, output.slice(-3000));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // On by default: public settings say so and the routes answer. Only an administrator can switch it off,
    // and then production routes answer 404 until it is switched back on.
    const settingsUrl = `http://127.0.0.1:${port}/api/settings`;
    const setEnabled = (bearer: string, value: unknown) => fetch(settingsUrl, { method: "PUT", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ feature_ai_memory_enabled: value }) });
    const publicFlag = async () => (await (await fetch(settingsUrl)).json() as any).feature_ai_memory_enabled;
    assert.equal(await publicFlag(), "true");
    assert.equal((await request("/capabilities", login("archive-http-owner"))).status, 200);
    assert.equal((await setEnabled(login("archive-http-owner"), false)).status, 403);
    assert.equal((await setEnabled(login("archive-http-admin"), "no")).status, 400);
    assert.equal(await publicFlag(), "true");
    assert.equal((await setEnabled(login("archive-http-admin"), false)).status, 200);
    assert.equal(await publicFlag(), "false");
    const disabled = await request("/capabilities", login("archive-http-owner"));
    assert.equal(disabled.status, 404); assert.equal(disabled.body.code, "AI_MEMORY_DISABLED");
    assert.equal((await request("/sources", scoped, { provider: "chatgpt", accountScope: "http-account", notebookId: "archive-http-granted", permissionState: "granted" })).body.code, "AI_MEMORY_DISABLED");
    assert.equal((await request("/imports", login("archive-http-owner"))).body.code, "AI_MEMORY_DISABLED");
    assert.equal((await setEnabled(login("archive-http-owner"), true)).status, 403);
    assert.equal((await setEnabled(login("archive-http-admin"), true)).status, 200);
    assert.equal(await publicFlag(), "true");
    assert.equal((await request("/capabilities", login("archive-http-owner"))).status, 200);
    assert.equal((await request("/sources", undefined, undefined, { "X-User-Id": "archive-http-owner" })).status, 401);
    assert.equal((await request("/sources", empty, undefined, { "X-Api-Scopes": "notes:read,notes:write", "X-User-Id": "archive-http-other" })).status, 403);
    // Where conversations may be saved is the person's own decision: API tokens cannot create sources.
    const source = { provider: "chatgpt", accountScope: "mcp:http-account", notebookId: "archive-http-granted", permissionState: "granted", captureEnabled: true };
    assert.equal((await request("/sources", readOnly, source)).status, 403);
    assert.equal((await request("/sources", scoped, { ...source, notebookId: "archive-http-other-notebook" })).status, 403);
    const minted = await request("/sources", scoped, source);
    assert.equal(minted.status, 403); assert.equal(minted.body.code, "AI_SOURCE_LOGIN_REQUIRED");
    const created = await request("/sources", login("archive-http-owner"), source);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // A file-import source does not let an API token (MCP) save conversations into it.
    const imported = await request("/sources", login("archive-http-owner"), { ...source, accountScope: "import:http-account", captureEnabled: false });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const snapshot = { provider: "chatgpt", accountScope: "mcp:http-account", externalConversationId: "http-conversation", title: "Private HTTP archive", sourceUrl: "https://chatgpt.com/c/http-conversation", completeness: "partial", capturedAt: new Date().toISOString(), messages: [{ externalMessageId: "http-message", localSequence: 0, role: "user", text: "private archive HTTP fixture", blocks: [{ type: "markdown", text: "private archive HTTP fixture" }], captureState: "stable" }] };
    const payload = { sourceId: created.body.id, operationId: crypto.randomUUID(), mode: "automatic", snapshot };
    const notForAssistants = await request("/conversations/ingest", scoped, { sourceId: imported.body.id, operationId: crypto.randomUUID(), mode: "manual",
      snapshot: { ...snapshot, accountScope: "import:http-account" } });
    assert.equal(notForAssistants.status, 403); assert.equal(notForAssistants.body.code, "AI_SOURCE_NOT_FOR_ASSISTANTS");
    const saved = await request("/conversations/ingest", scoped, payload);
    assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.persisted, true);
    assert.equal((await request(`/conversations/${saved.body.conversationId}/messages`, scoped)).body.items[0].text, "private archive HTTP fixture");
    assert.equal((await request(`/conversations/${saved.body.conversationId}`, login("archive-http-other"), undefined, { "X-User-Id": "archive-http-owner" })).status, 404);
    assert.equal((await request("/conversations/ingest", scoped, payload)).body.status, "duplicate");
    // Switching it off again hides the archive without deleting it.
    assert.equal((await setEnabled(login("archive-http-admin"), false)).status, 200);
    assert.equal((await request(`/conversations/${saved.body.conversationId}/messages`, scoped)).body.code, "AI_MEMORY_DISABLED");
    assert.equal((await request("/conversations/ingest", scoped, { ...payload, operationId: crypto.randomUUID() })).body.code, "AI_MEMORY_DISABLED");
    assert.equal((await setEnabled(login("archive-http-admin"), true)).status, 200);
    assert.equal((await request(`/conversations/${saved.body.conversationId}/messages`, scoped)).body.items[0].text, "private archive HTTP fixture");
    // A token may pause saving but cannot turn it back on.
    const patch = (body: unknown) => fetch(`${base}/sources/${created.body.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${scoped}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await patch({ captureEnabled: false })).status, 200);
    const reenabled = await patch({ captureEnabled: true });
    assert.equal(reenabled.status, 403); assert.equal((await reenabled.json() as any).code, "AI_SOURCE_LOGIN_REQUIRED");
    assert.equal((await patch({ permissionState: "granted" })).status, 403);
    assert.equal((await request(`/sources/${created.body.id}`, scoped)).body.captureEnabled, false);
    const revoke = await fetch(`${base}/sources/${created.body.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${login("archive-http-owner")}` } });
    assert.equal(revoke.status, 200);
    assert.equal((await request("/conversations/ingest", scoped, payload)).body.code, "AI_SOURCE_NOT_AUTHORIZED");
    assert.ok(!output.includes("private archive HTTP fixture"), "chat bodies must not be logged");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(null); else child.once("close", resolve); });
    schema.closeDb(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
