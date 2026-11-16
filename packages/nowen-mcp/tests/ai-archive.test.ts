import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pat = "nkn_ai_archive_integration_test_1234567890";
const resultText = (result: any): string => result.content?.map((entry: any) => entry.text || "").join("\n") || "";

/** A Nowen backend stand-in: two sources in the MCP's notebook (one for assistants, one for file imports) and one outside it. */
async function backendFixture() {
  const writes: Array<{ path: string; body: any }> = [];
  const state = { disabled: false };
  const sources = [
    { id: "assistant", provider: "standard", accountScope: "mcp:a", displayName: "Claude Code", notebookId: "root", captureEnabled: false, permissionState: "granted", lastSyncedAt: null },
    { id: "import", provider: "chatgpt", accountScope: "import:b", displayName: "ChatGPT export", notebookId: "root", captureEnabled: false, permissionState: "granted", lastSyncedAt: null },
    { id: "elsewhere", provider: "standard", accountScope: "mcp:c", displayName: "Outside", notebookId: "outside", captureEnabled: false, permissionState: "granted", lastSyncedAt: null },
  ];
  const archives: any[] = [{ id: "archive-outside", sourceId: "elsewhere", externalConversationId: "outside", title: "Outside", revision: 0, messageCount: 1, completeness: "partial", noteId: "n", projectionStatus: "updated", lastSyncedAt: null }];
  const messages = new Map<string, any[]>([["archive-outside", [{ externalMessageId: "x", role: "user", text: "outside secret" }]]]);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    res.setHeader("Content-Type", "application/json");
    const reply = (value: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${pat}`) return reply({ error: "Unauthorized" }, 401);
    if (req.method !== "GET") writes.push({ path: url.pathname, body: raw ? JSON.parse(raw) : null });
    if (url.pathname === "/api/notebooks") return reply([{ id: "root", parentId: null }, { id: "outside", parentId: null }]);
    if (url.pathname === "/api/notebooks/shared-with-me") return reply([]);
    if (url.pathname.startsWith("/api/ai-memory/") && state.disabled) return reply({ code: "AI_MEMORY_DISABLED", error: "此服务器未开启 AI 对话归档" }, 404);
    if (url.pathname === "/api/ai-memory/capabilities") return reply({ limits: { messages: 1000, text: 262144, snapshotBytes: 2097152, conversationMessages: 10000, conversationBytes: 16777216 } });
    if (url.pathname === "/api/ai-memory/sources") return reply({ items: sources });
    const source = /^\/api\/ai-memory\/sources\/([^/]+)$/.exec(url.pathname);
    if (source) { const found = sources.find((item) => item.id === source[1]); return found ? reply(found) : reply({ code: "AI_SOURCE_NOT_FOUND" }, 404); }
    if (url.pathname === "/api/ai-memory/conversations") {
      const sourceId = url.searchParams.get("sourceId"), external = url.searchParams.get("externalConversationId");
      const items = archives.filter((row) => (!sourceId || row.sourceId === sourceId) && (!external || row.externalConversationId === external));
      return reply({ items, total: items.length });
    }
    if (url.pathname === "/api/ai-memory/conversations/ingest") {
      const body = JSON.parse(raw);
      let row = archives.find((item) => item.sourceId === body.sourceId && item.externalConversationId === body.snapshot.externalConversationId);
      if (row) row.revision += 1;
      else { row = { id: `archive-${archives.length}`, sourceId: body.sourceId, externalConversationId: body.snapshot.externalConversationId, revision: 0, noteId: "note-1", projectionStatus: "updated", lastSyncedAt: null }; archives.push(row); }
      Object.assign(row, { title: body.snapshot.title, messageCount: body.snapshot.messages.length, completeness: body.snapshot.completeness });
      messages.set(row.id, body.snapshot.messages.map((item: any) => ({ ...item, userId: "internal-user-id", contentHash: "internal-hash" })));
      return reply({ operationId: body.operationId, sourceId: body.sourceId, conversationId: row.id, noteId: row.noteId, revision: row.revision, status: "applied", persisted: true, completeness: row.completeness, projectionStatus: "updated" });
    }
    const archive = /^\/api\/ai-memory\/conversations\/([^/]+)(\/messages)?$/.exec(url.pathname);
    if (archive) {
      const row = archives.find((item) => item.id === archive[1]);
      if (!row) return reply({ code: "AI_CONVERSATION_NOT_FOUND" }, 404);
      return reply(archive[2] ? { items: messages.get(row.id) || [] } : row);
    }
    return reply({ error: "Unexpected endpoint" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, writes, state, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function connect(url: string, mode = "read-write") {
  const client = new Client({ name: "ai-archive-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(packageRoot, "dist/scoped-entry.js")],
    env: { ...process.env, NOWEN_URL: url, NOWEN_API_TOKEN: pat, ALLOWED_NOTEBOOK_IDS: "root", MCP_INCLUDE_DESCENDANTS: "true", MCP_ACCESS_MODE: mode } as Record<string, string> }));
  return client;
}
const conversation = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `m${index + 1}`, role: index % 2 ? "assistant" : "user", text: `message ${index + 1}` }));

test("archive tools save only into assistant sources inside the MCP notebook scope and read without internal fields", async () => {
  const backend = await backendFixture();
  const client = await connect(backend.url);
  try {
    const sources = JSON.parse(resultText(await client.callTool({ name: "nowen_ai_archive_sources", arguments: {} })));
    assert.deepEqual(sources.sources.map((item: any) => item.id), ["assistant"]);
    assert.equal(sources.limits.messagesPerSave, 1000);

    const first = await client.callTool({ name: "nowen_ai_archive_save", arguments: { sourceId: "assistant", conversationId: "session-1", title: "Plan", messages: conversation(2) } });
    assert.ok(!first.isError, resultText(first));
    const saved = backend.writes[0].body;
    assert.equal(saved.mode, "manual"); assert.match(saved.operationId, /^mcp:/); assert.equal(saved.expectedRevision, undefined);
    assert.equal(saved.snapshot.provider, "standard"); assert.equal(saved.snapshot.accountScope, "mcp:a"); assert.equal(saved.snapshot.sourceUrl, "");
    assert.deepEqual(saved.snapshot.messages.map((item: any) => [item.externalMessageId, item.localSequence, item.captureState, item.blocks[0].type]),
      [["m1", 0, "stable", "markdown"], ["m2", 1, "stable", "markdown"]]);

    // Saving the same conversation again reuses the archive's current revision.
    const second = await client.callTool({ name: "nowen_ai_archive_save", arguments: { sourceId: "assistant", conversationId: "session-1", title: "Plan", messages: conversation(3), complete: true } });
    assert.ok(!second.isError, resultText(second));
    assert.equal(backend.writes[1].body.expectedRevision, 0);
    assert.equal(backend.writes[1].body.snapshot.completeness, "complete");

    // A file-import source, a source outside the MCP scope and duplicate message ids never reach the backend.
    for (const [args, pattern] of [
      [{ sourceId: "import", conversationId: "s", title: "t", messages: conversation(1) }, /AI 助手（MCP）/],
      [{ sourceId: "elsewhere", conversationId: "s", title: "t", messages: conversation(1) }, /错误/],
      [{ sourceId: "assistant", conversationId: "s", title: "t", messages: [...conversation(1), ...conversation(1)] }, /不能重复/],
    ] as const) {
      const refused = await client.callTool({ name: "nowen_ai_archive_save", arguments: args });
      assert.equal(refused.isError, true); assert.match(resultText(refused), pattern);
    }
    assert.equal(backend.writes.length, 2);

    const listed = JSON.parse(resultText(await client.callTool({ name: "nowen_ai_archive_list", arguments: {} })));
    assert.deepEqual(listed.items.map((item: any) => item.conversationId), ["session-1"]);
    const page = JSON.parse(resultText(await client.callTool({ name: "nowen_ai_archive_read", arguments: { archiveId: listed.items[0].id, limit: 2 } })));
    assert.deepEqual(page.messages.map((item: any) => item.text), ["message 1", "message 2"]);
    assert.equal(page.total, 3); assert.equal(page.nextOffset, 2);
    assert.doesNotMatch(JSON.stringify(page), /internal-user-id|internal-hash/);
    const outside = await client.callTool({ name: "nowen_ai_archive_read", arguments: { archiveId: "archive-outside" } });
    assert.equal(outside.isError, true); assert.doesNotMatch(resultText(outside), /outside secret/);
  } finally { await client.close(); await backend.close(); }
});

test("read-only archive MCP can read but cannot save", async () => {
  const backend = await backendFixture();
  const client = await connect(backend.url, "read-only");
  try {
    assert.ok(!(await client.callTool({ name: "nowen_ai_archive_sources", arguments: {} })).isError);
    const refused = await client.callTool({ name: "nowen_ai_archive_save", arguments: { sourceId: "assistant", conversationId: "s", title: "t", messages: conversation(1) } });
    assert.equal(refused.isError, true);
    assert.equal(backend.writes.length, 0);
  } finally { await client.close(); await backend.close(); }
});

test("archive tools say plainly when the server has the archive switched off", async () => {
  const backend = await backendFixture();
  backend.state.disabled = true;
  const client = await connect(backend.url);
  try {
    for (const [name, args] of [["nowen_ai_archive_sources", {}], ["nowen_ai_archive_save", { sourceId: "assistant", conversationId: "s", title: "t", messages: conversation(1) }]] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true); assert.match(resultText(result), /未开启 AI 对话归档/);
    }
    assert.equal(backend.writes.length, 0);
  } finally { await client.close(); await backend.close(); }
});
