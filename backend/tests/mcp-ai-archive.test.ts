import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-mcp-archive-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.ELECTRON_USER_DATA = dir;

// The real embedded MCP (built packages/nowen-mcp) against the real archive service and token checks.
test("AI conversation archive over embedded MCP", async (t) => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  const { getDb, closeDb } = await import("../src/db/schema");
  const { initApiTokensTable, hashApiToken, resolveApiToken } = await import("../src/lib/api-tokens");
  const { enforceApiTokenAccess } = await import("../src/middleware/api-token-resource-scope");
  const { createEmbeddedMcpRouter, createMcpSettingsRouter } = await import("../src/mcp");
  const { default: aiMemory } = await import("../src/routes/ai-memory");
  const service = await import("../src/services/aiMemoryService");
  const db = getDb();
  try {
    initApiTokensTable(db);
    const { initAuditTables } = await import("../src/services/audit");
    initAuditTables();
    db.exec(`INSERT INTO users (id, username, passwordHash, role) VALUES ('arch-a','arch-a','hash','admin'), ('arch-b','arch-b','hash','user');
      INSERT INTO notebooks (id, name, userId) VALUES ('arch-book-a','Book A','arch-a'), ('arch-book-x','Not granted','arch-a'), ('arch-book-b','Book B','arch-b');`);
    const tokens = { a: "nkn_archive-mcp-token-user-a-1234567890", b: "nkn_archive-mcp-token-user-b-1234567890" };
    for (const [key, value] of Object.entries(tokens)) {
      db.prepare("INSERT INTO api_tokens (id,userId,name,tokenHash,scopes,resourceMode) VALUES (?,?,?,?,?,'restricted')")
        .run(`arch-token-${key}`, `arch-${key}`, key, hashApiToken(value), JSON.stringify(["notes:read", "notes:write", "notebooks:read"]));
      db.prepare("INSERT INTO api_token_resources (id,tokenId,resourceType,resourceId,permission,includeDescendants) VALUES (?,?,'notebook',?,'write',0)")
        .run(`arch-grant-${key}`, `arch-token-${key}`, `arch-book-${key}`);
    }
    const app = new Hono();
    app.route("/mcp", createEmbeddedMcpRouter((request) => app.fetch(request)));
    app.use("/api/*", async (c, next) => {
      for (const header of ["X-User-Id", "X-Auth-Mode", "X-Api-Token-Id", "X-Api-Scopes", "X-Api-Resource-Mode"]) c.req.raw.headers.delete(header);
      const bearer = (c.req.header("Authorization") || "").slice(7);
      if (bearer === "admin-session") c.req.raw.headers.set("X-User-Id", "arch-a");
      else {
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
    app.route("/api/ai-memory", aiMemory);
    const configure = async (allowWrite: boolean) => assert.equal((await app.request("http://localhost/api/mcp", {
      method: "PUT", headers: { Authorization: "Bearer admin-session", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, allowWrite, publicUrl: "https://note.example.com/mcp" }) })).status, 200);
    const tool = async (bearer: string, name: string, args: unknown = {}) => {
      const res = await app.request("https://note.example.com/mcp", { method: "POST", headers: {
        Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      assert.equal(res.status, 200, await res.clone().text());
      const result = (await res.json() as any).result;
      return { isError: result.isError === true, text: result.content.map((entry: any) => entry.text).join("\n") };
    };
    const json = (result: { isError: boolean; text: string }) => { assert.equal(result.isError, false, result.text); return JSON.parse(result.text); };
    const setArchive = (enabled: boolean) => db.prepare("INSERT INTO system_settings(key,value) VALUES ('feature_ai_memory_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(enabled));
    const conversation = (count: number, last = "") => Array.from({ length: count }, (_, index) => ({ id: `m${index + 1}`, role: index % 2 ? "assistant" : "user",
      text: index === count - 1 && last ? last : `message ${index + 1}` }));
    await configure(true);

    // The person creates sources in the AI memory page (a login session, not a token).
    const person = { userId: "arch-a" };
    const assistant = service.createAIMemorySource(person, { provider: "standard", accountScope: "mcp:claude", displayName: "Claude Code", notebookId: "arch-book-a", permissionState: "granted" });
    const fileImport = service.createAIMemorySource(person, { provider: "chatgpt", accountScope: "import:export", displayName: "ChatGPT export", notebookId: "arch-book-a", permissionState: "granted" });
    const ungranted = service.createAIMemorySource(person, { provider: "standard", accountScope: "mcp:other", displayName: "Other", notebookId: "arch-book-x", permissionState: "granted" });
    const save = (args: Record<string, unknown> = {}, bearer = tokens.a) => tool(bearer, "nowen_ai_archive_save", { sourceId: assistant.id, conversationId: "session-1", title: "Release plan", messages: conversation(2), ...args });

    await t.test("the tools explain a server with the archive switched off", async () => {
      setArchive(false);
      const off = await tool(tokens.a, "nowen_ai_archive_sources");
      assert.equal(off.isError, true); assert.match(off.text, /未开启 AI 对话归档/);
      assert.equal((await save()).isError, true);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM external_ai_conversations").get().count, 0);
      setArchive(true);
    });

    let archiveId = "";
    await t.test("DCC-006: embedded MCP saves and reads AI archives only within the token's notebook grants and assistant sources", async () => {
      assert.deepEqual(json(await tool(tokens.a, "nowen_ai_archive_sources")).sources.map((item: any) => item.id), [assistant.id]);
      const first = json(await save());
      assert.equal(first.status, "applied"); assert.ok(first.noteId);
      archiveId = first.archiveId;
      const note = db.prepare("SELECT notebookId, content FROM notes WHERE id=?").get(first.noteId) as { notebookId: string; content: string };
      assert.equal(note.notebookId, "arch-book-a"); assert.match(note.content, /message 2/);
      // Saving the same conversation again changes nothing; appending keeps the earlier messages.
      assert.equal(json(await save()).status, "duplicate");
      const appended = json(await save({ messages: conversation(3) }));
      assert.equal(appended.status, "applied"); assert.equal(appended.revision, first.revision + 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM external_ai_conversations").get().count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM external_ai_messages WHERE conversationId=?").get(archiveId).count, 3);

      for (const sourceId of [fileImport.id, ungranted.id]) {
        const refused = await save({ sourceId, conversationId: "session-2" });
        assert.equal(refused.isError, true, sourceId);
      }
      assert.equal((await save({ automatic: true, conversationId: "session-3" })).text.includes("AI_CAPTURE_PAUSED"), true);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM external_ai_conversations").get().count, 1);

      assert.deepEqual(json(await tool(tokens.a, "nowen_ai_archive_list")).items.map((item: any) => item.id), [archiveId]);
      assert.deepEqual(json(await tool(tokens.b, "nowen_ai_archive_list")).items, []);
      const read = json(await tool(tokens.a, "nowen_ai_archive_read", { archiveId }));
      assert.deepEqual(read.messages.map((item: any) => [item.id, item.role, item.text]), [["m1", "user", "message 1"], ["m2", "assistant", "message 2"], ["m3", "user", "message 3"]]);
      const other = await tool(tokens.b, "nowen_ai_archive_read", { archiveId });
      assert.equal(other.isError, true); assert.doesNotMatch(other.text, /message 1/);
    });

    await t.test("DCC-004: a stale revision from MCP is refused without overwriting the archive", async () => {
      const stale = await save({ messages: conversation(3, "rewritten from an old copy"), expectedRevision: 0 });
      assert.equal(stale.isError, true); assert.match(stale.text, /AI_SYNC_VERSION_CONFLICT/);
      assert.equal((db.prepare("SELECT contentText FROM external_ai_messages WHERE conversationId=? AND externalMessageId='m3'").get(archiveId) as any).contentText, "message 3");
    });

    await t.test("a read-only MCP connection can read archives but cannot save", async () => {
      await configure(false);
      assert.equal((await save({ messages: conversation(4) })).isError, true);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM external_ai_messages WHERE conversationId=?").get(archiveId).count, 3);
      assert.equal(json(await tool(tokens.a, "nowen_ai_archive_read", { archiveId })).total, 3);
    });
  } finally {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
