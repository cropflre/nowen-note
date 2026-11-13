import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-embedded-mcp-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.ELECTRON_USER_DATA = dir;

test("DCC-006: embedded MCP isolates concurrent credentials, notebook grants and revocation", async (t) => {
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
    const { default: tokenRoutes } = await import("../src/routes/tokens");
    app.route("/api/tokens", tokenRoutes);
    await t.test("DCC-006: MCP connection expiry persists permanent and custom grants without allowing PAT self-management", async () => {
      const create = (days?: number, bearer = "admin-session") => app.request("http://localhost/api/tokens", {
        method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "MCP · expiry test", resourceMode: "restricted",
          scopes: ["notes:read", "notebooks:read", "notes:write"],
          notebookResources: [{ notebookId: "mcp-book-a", permission: "write", includeDescendants: false }],
          ...(days === undefined ? { expiresAt: null } : { expiresInDays: days }),
        }),
      });
      const permanent = await create();
      assert.equal(permanent.status, 201);
      const saved = await permanent.json() as any;
      assert.equal(saved.expiresAt, null);
      assert.deepEqual(db.prepare("SELECT expiresAt FROM api_tokens WHERE id=?").get(saved.id), { expiresAt: null });
      assert.ok(resolveApiToken(db, saved.token));
      const started = Date.now();
      const custom = await create(30);
      assert.equal(custom.status, 201);
      const expiring = await custom.json() as any;
      const expiry = Date.parse(expiring.expiresAt);
      assert.ok(expiry >= started + 30 * 86400_000 && expiry <= Date.now() + 30 * 86400_000);
      assert.deepEqual(db.prepare("SELECT expiresAt FROM api_tokens WHERE id=?").get(expiring.id), { expiresAt: expiring.expiresAt });
      assert.equal((await create(undefined, saved.token)).status, 403);
      db.prepare("UPDATE api_tokens SET expiresAt='2000-01-01T00:00:00Z' WHERE id=?").run(expiring.id);
      assert.equal(resolveApiToken(db, expiring.token), null);
      assert.ok(resolveApiToken(db, saved.token), "permanent grant remains valid");
    });
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
    await t.test("DCC-006: restricted MCP grants support multiple selected notebooks without widening user or task access", async () => {
      db.exec(`INSERT INTO notebooks (id, name, userId, parentId) VALUES
        ('mcp-book-selected','Selected Book','mcp-a',NULL),
        ('mcp-book-unselected-child','Unselected Child','mcp-a','mcp-book-selected'),
        ('mcp-book-read-parent','Read Parent','mcp-a',NULL),
        ('mcp-book-write-child','Write Child','mcp-a','mcp-book-read-parent');
        INSERT INTO notes (id,title,notebookId,userId,content,contentText) VALUES
        ('mcp-note-readonly','Read Only','mcp-book-read-parent','mcp-a','Read body','Read body'),
        ('mcp-note-unselected-child','Excluded child note','mcp-book-unselected-child','mcp-a','Excluded body','Excluded body');
        INSERT INTO api_token_resources (id,tokenId,resourceType,resourceId,permission,includeDescendants) VALUES
        ('mcp-grant-selected','mcp-token-a','notebook','mcp-book-selected','write',0),
        ('mcp-grant-parent','mcp-token-a','notebook','mcp-book-read-parent','read',0),
        ('mcp-grant-child','mcp-token-a','notebook','mcp-book-write-child','write',0);`);
      const catalog = JSON.stringify(await tool(tokens.a, "nowen_list_notebooks"));
      assert.match(catalog, /Selected Book/);
      assert.match(catalog, /Read Parent/);
      assert.match(catalog, /Write Child/);
      assert.doesNotMatch(catalog, /Book B|Denied|Unselected Child/);
      for (const notebookId of ["mcp-book-a", "mcp-book-selected", "mcp-book-write-child"]) {
        const title = `Created in ${notebookId}`;
        const created = await tool(tokens.a, "nowen_create_note", { notebookId, title, content: "Original body" });
        assert.equal(created.isError, undefined, JSON.stringify(created));
        const note = db.prepare("SELECT id FROM notes WHERE notebookId=? AND title=?").get(notebookId, title) as { id: string };
        assert.ok(note?.id);
        const read = await tool(tokens.a, "nowen_read_note", { noteId: note.id });
        assert.equal(read.isError, undefined);
        assert.match(JSON.stringify(read), /Original body/);
        assert.equal((await tool(tokens.a, "nowen_update_note", { noteId: note.id, title: `${title} updated`, content: "Updated body" })).isError, undefined);
        const updated = db.prepare("SELECT title,contentText FROM notes WHERE id=?").get(note.id) as { title: string; contentText: string };
        assert.equal(updated.title, `${title} updated`);
        assert.equal(updated.contentText, "Updated body");
      }
      const readonlyBefore = db.prepare("SELECT * FROM notes WHERE id='mcp-note-readonly'").get();
      assert.equal((await tool(tokens.a, "nowen_read_note", { noteId: "mcp-note-readonly" })).isError, undefined);
      assert.equal((await tool(tokens.a, "nowen_update_note", { noteId: "mcp-note-readonly", content: "Denied" })).isError, true);
      assert.equal((await tool(tokens.a, "nowen_create_note", { notebookId: "mcp-book-read-parent", title: "Denied read-only creation" })).isError, true);
      assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id='mcp-note-readonly'").get(), readonlyBefore);
      assert.equal(db.prepare("SELECT id FROM notes WHERE title='Denied read-only creation'").get(), undefined);
      const excludedBefore = db.prepare("SELECT * FROM notes WHERE id='mcp-note-unselected-child'").get();
      assert.equal((await tool(tokens.a, "nowen_read_note", { noteId: "mcp-note-unselected-child" })).isError, true);
      assert.equal((await tool(tokens.a, "nowen_update_note", { noteId: "mcp-note-unselected-child", content: "Denied inherited edit" })).isError, true);
      assert.equal((await tool(tokens.a, "nowen_create_note", { notebookId: "mcp-book-unselected-child", title: "Denied inherited creation" })).isError, true);
      assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id='mcp-note-unselected-child'").get(), excludedBefore);
      assert.equal(db.prepare("SELECT id FROM notes WHERE title='Denied inherited creation'").get(), undefined);
      assert.equal((await tool(tokens.a, "nowen_create_notebook", { name: "Denied root" })).isError, true);
      assert.equal(db.prepare("SELECT id FROM notebooks WHERE name='Denied root'").get(), undefined);
      assert.equal((await tool(tokens.a, "nowen_create_notebook", { parentId: "mcp-book-selected", name: "Denied child folder" })).isError, true);
      assert.equal(db.prepare("SELECT id FROM notebooks WHERE name='Denied child folder'").get(), undefined);
      assert.equal((await tool(tokens.a, "nowen_list_tasks")).isError, true);
      // Even an erroneously broad resource grant must not bypass the user's ACL.
      db.prepare(`INSERT INTO api_token_resources (id,tokenId,resourceType,resourceId,permission,includeDescendants)
        VALUES ('mcp-grant-foreign','mcp-token-a','notebook','mcp-book-b','write',0)`).run();
      const foreignBefore = db.prepare("SELECT * FROM notes WHERE id='mcp-note-b'").get();
      assert.equal((await tool(tokens.a, "nowen_read_note", { noteId: "mcp-note-b" })).isError, true);
      assert.equal((await tool(tokens.a, "nowen_update_note", { noteId: "mcp-note-b", content: "Denied foreign edit" })).isError, true);
      assert.equal((await tool(tokens.a, "nowen_create_note", { notebookId: "mcp-book-b", title: "Denied foreign creation" })).isError, true);
      assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id='mcp-note-b'").get(), foreignBefore);
      assert.equal(db.prepare("SELECT id FROM notes WHERE title='Denied foreign creation'").get(), undefined);
      assert.doesNotMatch(JSON.stringify(await tool(tokens.a, "nowen_list_notebooks")), /Book B/);
      db.prepare("DELETE FROM api_token_resources WHERE id='mcp-grant-foreign'").run();
    });
    await t.test("DCC-007: embedded MCP requires current confirmed deletion and retains notes in the recycle bin", async () => {
      db.exec(`INSERT INTO notes (id,title,notebookId,userId,content,contentText) VALUES
        ('mcp-note-delete','Delete safely','mcp-book-selected','mcp-a','Retained body','Retained body');`);
      const beforeDelete = db.prepare("SELECT * FROM notes WHERE id='mcp-note-delete'").get() as { version: number };
      const preview = await tool(tokens.a, "nowen_delete_note", { noteId: "mcp-note-delete" });
      assert.equal(preview.isError, undefined);
      assert.match(JSON.stringify(preview), /未执行/);
      for (const args of [
        { dryRun: false, expectedVersion: beforeDelete.version },
        { dryRun: false, expectedVersion: beforeDelete.version + 1, confirmation: "MOVE_TO_TRASH" },
        { permanent: true },
      ]) {
        assert.equal((await tool(tokens.a, "nowen_delete_note", { noteId: "mcp-note-delete", ...args })).isError, true);
        assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id='mcp-note-delete'").get(), beforeDelete);
      }
      for (const noteId of ["mcp-note-readonly", "mcp-note-unselected-child", "mcp-note-b"]) {
        const untouched = db.prepare("SELECT * FROM notes WHERE id=?").get(noteId) as { version: number };
        assert.equal((await tool(tokens.a, "nowen_delete_note", { noteId, dryRun: false, expectedVersion: untouched.version, confirmation: "MOVE_TO_TRASH" })).isError, true);
        assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id=?").get(noteId), untouched);
      }
      const removed = await tool(tokens.a, "nowen_delete_note", { noteId: "mcp-note-delete", dryRun: false, expectedVersion: beforeDelete.version, confirmation: "MOVE_TO_TRASH" });
      assert.equal(removed.isError, undefined, JSON.stringify(removed));
      const retained = db.prepare("SELECT isTrashed,contentText,notebookId FROM notes WHERE id='mcp-note-delete'").get();
      assert.deepEqual(retained, { isTrashed: 1, contentText: "Retained body", notebookId: "mcp-book-selected" });
      assert.equal((await tool(tokens.a, "nowen_delete_note", { noteId: "mcp-note-delete", permanent: true })).isError, true);
      assert.deepEqual(db.prepare("SELECT isTrashed,contentText,notebookId FROM notes WHERE id='mcp-note-delete'").get(), retained);
    });
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
