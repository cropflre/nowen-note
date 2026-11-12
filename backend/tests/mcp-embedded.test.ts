import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-embedded-mcp-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.ELECTRON_USER_DATA = dir;

test("DCC-006: embedded MCP isolates concurrent credentials, notebook grants and revocation", async () => {
  const { getDb, closeDb } = await import("../src/db/schema");
  const { initApiTokensTable, hashApiToken, resolveApiToken } = await import("../src/lib/api-tokens");
  const { enforceApiTokenAccess } = await import("../src/middleware/api-token-resource-scope");
  const { createEmbeddedMcpRouter, createMcpSettingsRouter } = await import("../src/mcp");
  const { default: notebooks } = await import("../src/routes/notebooks");
  const { default: notes } = await import("../src/routes/notes");
  const db = getDb();
  try {
    initApiTokensTable(db);
    const { initAuditTables } = await import("../src/services/audit");
    initAuditTables();
    db.exec(`INSERT INTO users (id, username, passwordHash, role) VALUES
      ('mcp-a','mcp-a','hash','admin'), ('mcp-b','mcp-b','hash','user');
      INSERT INTO notebooks (id, name, userId) VALUES
      ('mcp-book-a','Book A','mcp-a'), ('mcp-book-b','Book B','mcp-b'), ('mcp-book-denied','Denied','mcp-a');
      INSERT INTO notes (id, title, notebookId, userId, content, contentText) VALUES
      ('mcp-note-a','Note A','mcp-book-a','mcp-a','A private body','A private body'),
      ('mcp-note-b','Note B','mcp-book-b','mcp-b','B private body','B private body');`);
    const tokens = { a: "nkn_embedded-test-token-user-a-12345678", b: "nkn_embedded-test-token-user-b-12345678" };
    for (const [key, value] of Object.entries(tokens)) {
      db.prepare(`INSERT INTO api_tokens (id,userId,name,tokenHash,scopes,resourceMode)
        VALUES (?,?,?,?,?,'restricted')`).run(`mcp-token-${key}`, `mcp-${key}`, key, hashApiToken(value),
        JSON.stringify(["notes:read", "notes:write", "notebooks:read", "notebooks:write"]));
      db.prepare(`INSERT INTO api_token_resources (id,tokenId,resourceType,resourceId,permission,includeDescendants)
        VALUES (?,?,'notebook',?,'write',0)`).run(`mcp-grant-${key}`, `mcp-token-${key}`, `mcp-book-${key}`);
    }
    const app = new Hono();
    app.route("/mcp", createEmbeddedMcpRouter(request => app.fetch(request)));
    app.use("/api/*", async (c, next) => {
      for (const header of ["X-User-Id", "X-Auth-Mode", "X-Api-Token-Id", "X-Api-Scopes", "X-Api-Resource-Mode"]) c.req.raw.headers.delete(header);
      const bearer = (c.req.header("Authorization") || "").slice(7);
      if (bearer === "admin-session" || bearer === "user-session") {
        c.req.raw.headers.set("X-User-Id", bearer === "admin-session" ? "mcp-a" : "mcp-b");
      } else {
        const resolved = resolveApiToken(db, bearer);
        if (!resolved) return c.json({ error: "Unauthorized" }, 401);
        c.req.raw.headers.set("X-User-Id", resolved.userId);
        c.req.raw.headers.set("X-Auth-Mode", "api-token");
        c.req.raw.headers.set("X-Api-Token-Id", resolved.tokenId);
        c.req.raw.headers.set("X-Api-Resource-Mode", resolved.resourceMode);
        c.req.raw.headers.set("X-Api-Scopes", resolved.scopes.join(","));
      }
      await next();
    });
    app.use("/api/*", enforceApiTokenAccess);
    app.route("/api/mcp", createMcpSettingsRouter());
    app.route("/api/notebooks", notebooks);
    app.route("/api/notes", notes);
    const configure = (body: unknown, bearer = "admin-session") => app.request("http://localhost/api/mcp", {
      method: "PUT", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const settings = { enabled: true, allowWrite: false, publicUrl: "https://note.example.com/mcp" };
    const rpc = (bearer: string, method: string, params: unknown = {}, headers: Record<string, string> = {}) =>
      app.request("https://note.example.com/mcp", { method: "POST", headers: {
        Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers,
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const tool = async (bearer: string, name: string, args: unknown = {}) => {
      const res = await rpc(bearer, "tools/call", { name, arguments: args });
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json() as any).result;
    };
    assert.equal((await rpc(tokens.a, "tools/list")).status, 404, "disabled by default");
    assert.equal((await configure(settings, "user-session")).status, 403);
    assert.equal((await configure(settings, tokens.a)).status, 403, "PAT cannot enable its own gateway");
    assert.equal((await configure({ ...settings, publicUrl: "javascript:alert(1)" })).status, 400);
    assert.equal((await configure(settings)).status, 200);
    assert.equal((await rpc("", "tools/list")).status, 401);
    assert.equal((await rpc("admin-session", "tools/list")).status, 401, "MCP accepts PAT only");
    assert.equal((await rpc(tokens.a, "tools/list", {}, { Origin: "https://attacker.example" })).status, 403);
    assert.equal((await rpc(tokens.a, "tools/list", {}, { Host: "attacker.example" })).status, 403);
    assert.equal((await app.request("https://attacker.example/mcp", { method: "POST" })).status, 403);
    assert.equal((await app.request("https://note.example.com/mcp", { method: "OPTIONS", headers: { Origin: "https://attacker.example" } })).status, 403);
    const preflight = await app.request("https://note.example.com/mcp", { method: "OPTIONS", headers: { Origin: "https://note.example.com" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://note.example.com");
    assert.equal((await app.request("https://note.example.com/mcp", { headers: { Authorization: `Bearer ${tokens.a}` } })).status, 405);
    for (const [body, contentType, expected] of [["{", "application/json", 400], ["{}", "text/plain", 415], ["x".repeat(1_048_577), "application/json", 413]] as const) {
      assert.equal((await app.request("https://note.example.com/mcp", { method: "POST", headers: {
        Authorization: `Bearer ${tokens.a}`, "Content-Type": contentType,
      }, body })).status, expected);
    }
    const initialized = await rpc(tokens.a, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(initialized.status, 200, await initialized.clone().text());
    assert.equal((await initialized.json() as any).result.serverInfo.name, "nowen-note");
    assert.equal((await rpc(tokens.a, "tools/list")).status, 200);
    const calls = await Promise.all(Array.from({ length: 12 }, (_, i) => tool(i % 2 ? tokens.a : tokens.b, "nowen_list_notebooks")));
    calls.forEach((result, i) => {
      const output = JSON.stringify(result);
      assert.match(output, i % 2 ? /Book A/ : /Book B/);
      assert.doesNotMatch(output, i % 2 ? /Book B|Denied/ : /Book A|Denied/);
    });
    assert.equal((await tool(tokens.a, "nowen_read_note", { noteId: "mcp-note-b" })).isError, true);
    db.prepare("UPDATE api_tokens SET expiresAt='2000-01-01T00:00:00Z' WHERE id='mcp-token-a'").run();
    assert.equal((await rpc(tokens.a, "tools/list")).status, 401);
    db.prepare("UPDATE api_tokens SET expiresAt=NULL, scopes='[]' WHERE id='mcp-token-a'").run();
    assert.equal((await tool(tokens.a, "nowen_list_notebooks")).isError, true, "empty scopes cannot read");
    db.prepare("UPDATE api_tokens SET scopes=? WHERE id='mcp-token-a'").run(JSON.stringify(["notes:read", "notes:write", "notebooks:read"]));
    db.prepare("UPDATE users SET isDisabled=1 WHERE id='mcp-a'").run();
    assert.equal((await rpc(tokens.a, "tools/list")).status, 401);
    db.prepare("UPDATE users SET isDisabled=0 WHERE id='mcp-a'").run();
    const originalDangerous = process.env.MCP_ENABLE_DANGEROUS_TOOLS;
    process.env.MCP_ENABLE_DANGEROUS_TOOLS = "true";
    try {
      const diagnostics = await tool(tokens.a, "nowen_mcp_diagnostics");
      assert.equal(JSON.parse(diagnostics.content[0].text).dangerousToolsEnabled, false);
      assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(tokens.a));
      assert.equal((await tool(tokens.a, "nowen_upload_attachment", { filePath: "/etc/passwd" })).isError, true);
    } finally {
      if (originalDangerous === undefined) delete process.env.MCP_ENABLE_DANGEROUS_TOOLS;
      else process.env.MCP_ENABLE_DANGEROUS_TOOLS = originalDangerous;
    }
    const before = db.prepare("SELECT * FROM notes WHERE id='mcp-note-a'").get();
    assert.equal((await tool(tokens.a, "nowen_update_note", { noteId: "mcp-note-a", title: "Denied write" })).isError, true);
    assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id='mcp-note-a'").get(), before);
    assert.equal((await configure({ ...settings, allowWrite: true })).status, 200);
    assert.equal((await tool(tokens.a, "nowen_update_note", { noteId: "mcp-note-a", title: "Allowed write" })).isError, undefined);
    assert.equal((db.prepare("SELECT title FROM notes WHERE id='mcp-note-a'").get() as any).title, "Allowed write");
    db.prepare("UPDATE api_token_resources SET permission='read' WHERE tokenId='mcp-token-a'").run();
    assert.equal((await tool(tokens.a, "nowen_update_note", { noteId: "mcp-note-a", title: "Still denied" })).isError, true);
    db.prepare("UPDATE api_tokens SET revokedAt=datetime('now') WHERE id='mcp-token-a'").run();
    assert.equal((await rpc(tokens.a, "tools/list")).status, 401);
    assert.equal((await rpc(tokens.b, "tools/list")).status, 200);
    closeDb();
    assert.equal((await app.request("http://localhost/api/mcp", { headers: { Authorization: "Bearer admin-session" } })).status, 200);
    assert.equal((await rpc(tokens.b, "tools/list")).status, 200, "configuration persists after DB reopen");
    assert.equal((await configure({ ...settings, enabled: false })).status, 200);
    assert.equal((await rpc(tokens.b, "tools/list")).status, 404);
  } finally {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
