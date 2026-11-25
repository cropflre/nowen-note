import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-mcp-team-"));
process.env.DB_PATH = path.join(dir, "team.db");
process.env.ELECTRON_USER_DATA = dir;

const here = path.dirname(fileURLToPath(import.meta.url));
const stdioEntry = path.resolve(here, "../../packages/nowen-mcp/dist/scoped-entry.js");
const WS = "ws-prod";
const OPS = "ws-ops";
const SECRET_BODY = "teamsecretbody launch alphaword";

type ToolResult = { content?: Array<{ text?: string }>; isError?: boolean };
const text = (result: ToolResult) => (result.content || []).map((item) => item.text || "").join("\n");
const json = (result: ToolResult) => JSON.parse(text(result));

/** Minimal newline-delimited JSON-RPC client for the standalone stdio MCP entry. */
async function startStdioMcp(baseUrl: string, token: string) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [stdioEntry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NOWEN_URL: baseUrl, NOWEN_API_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, (message: any) => void>();
  let buffer = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`stdio MCP timed out on ${method}`)), 20_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "team-space-test", version: "1" },
  });
  assert.equal(initialized.result?.serverInfo?.name, "nowen-note");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await request("tools/call", { name, arguments: args })).result as ToolResult,
    close: async () => {
      child.kill();
      if (child.exitCode === null) await once(child, "exit");
    },
  };
}

test("team-space MCP authorization", async (t) => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema");
  const { initApiTokensTable, resolveApiToken } = await import("../src/lib/api-tokens");
  const { initAuditTables } = await import("../src/services/audit");
  const { enforceApiTokenAccess } = await import("../src/middleware/api-token-resource-scope");
  const { createEmbeddedMcpRouter, createMcpSettingsRouter } = await import("../src/mcp");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree");
  const { default: notebooks } = await import("../src/routes/notebooks");
  const { default: notes } = await import("../src/routes/notes");
  const { default: search } = await import("../src/routes/search");
  const { default: blocks } = await import("../src/routes/blocks");
  const { default: files } = await import("../src/routes/files");
  const { default: tree } = await import("../src/routes/knowledge-tree");
  const { default: tokenRoutes } = await import("../src/routes/tokens");
  const { serve } = await import("@hono/node-server");
  const db = getDb();
  let server: ReturnType<typeof serve> | undefined;
  try {
    initApiTokensTable(db);
    initAuditTables();
    db.exec(`
      INSERT INTO users (id, username, passwordHash, role) VALUES
        ('u-owner','u-owner','hash','user'), ('u-admin','u-admin','hash','user'),
        ('u-editor','u-editor','hash','user'), ('u-commenter','u-commenter','hash','user'),
        ('u-viewer','u-viewer','hash','user'), ('u-outsider','u-outsider','hash','user'),
        ('u-sysadmin','u-sysadmin','hash','admin');
      INSERT INTO workspaces (id, name, ownerId) VALUES
        ('${WS}', '产品研发团队', 'u-owner'), ('${OPS}', '运营团队', 'u-outsider');
      INSERT INTO workspace_members (workspaceId, userId, role) VALUES
        ('${WS}','u-owner','owner'), ('${WS}','u-admin','admin'), ('${WS}','u-editor','editor'),
        ('${WS}','u-commenter','commenter'), ('${WS}','u-viewer','viewer'),
        ('${OPS}','u-outsider','owner'), ('${OPS}','u-editor','viewer');
    `);
    const folder = (actor: string, workspaceId: string | null, title: string, parentId: string | null = null) =>
      createKnowledgeChild({ actorUserId: actor, workspaceId, parentId, nodeType: "folder", title, db });
    const markdown = (actor: string, workspaceId: string | null, parentId: string, title: string, body: string) => {
      const node = createKnowledgeChild({ actorUserId: actor, workspaceId, parentId, nodeType: "markdown", title, db });
      db.prepare("UPDATE notes SET content = ?, contentText = ?, contentFormat = 'markdown' WHERE id = ?")
        .run(body, body, node.resourceId);
      return node;
    };
    // 个人空间与团队空间故意都有一个「项目文档」，用于验证同名笔记本不会混淆。
    const personal = folder("u-editor", null, "项目文档");
    const docs = folder("u-owner", WS, "项目文档");
    const tech = folder("u-owner", WS, "技术方案");
    const secret = folder("u-owner", WS, "保密资料");
    const ops = folder("u-outsider", OPS, "运营资料");
    const personalNote = markdown("u-editor", null, personal.id, "个人周记", "personal alphaword body");
    const docsNote = markdown("u-owner", WS, docs.id, "需求说明", "team requirement alphaword body");
    const treeNote = markdown("u-owner", WS, docs.id, "目录练习", "tree practice body");
    const secretNote = markdown("u-owner", WS, secret.id, "保密计划", SECRET_BODY);
    const opsNote = markdown("u-outsider", OPS, ops.id, "运营周报", "ops weekly alphaword body");
    // 历史数据：没有知识树节点、userId 恰好是编辑者本人的团队笔记（ACL 会走“所有者”回退）。
    db.prepare(`INSERT INTO notes (id, userId, workspaceId, notebookId, title, content, contentText, contentFormat)
      VALUES ('legacy-team-note', 'u-editor', ?, ?, '接口设计', 'legacy alphaword api', 'legacy alphaword api', 'markdown')`)
      .run(WS, tech.resourceId);

    const app = new Hono();
    app.route("/mcp", createEmbeddedMcpRouter((request) => app.fetch(request)));
    app.use("/api/*", async (c, next) => {
      for (const header of ["X-User-Id", "X-Auth-Mode", "X-Api-Token-Id", "X-Api-Scopes", "X-Api-Resource-Mode", "X-Api-Allowed-Notebook-Ids"]) {
        c.req.raw.headers.delete(header);
      }
      const bearer = (c.req.header("Authorization") || "").slice(7);
      if (bearer.startsWith("session:")) {
        c.req.raw.headers.set("X-User-Id", bearer.slice("session:".length));
      } else {
        const resolved = resolveApiToken(db, bearer);
        if (!resolved) return c.json({ error: "Unauthorized", code: "API_TOKEN_INVALID" }, 401);
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
    app.route("/api/tokens", tokenRoutes);
    app.route("/api/knowledge-tree/", tree);
    app.route("/api/notebooks", notebooks);
    app.route("/api/notes", notes);
    app.route("/api/search", search);
    app.route("/api/blocks", blocks);
    app.route("/api/files", files);

    const api = (bearer: string, url: string, init: { method?: string; body?: unknown } = {}) => app.request(`http://localhost${url}`, {
      method: init.method || "GET",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const session = (userId: string) => `session:${userId}`;
    type Grant = { notebookId: string; permission: "read" | "write" };
    const createToken = async (userId: string, grants: Grant[], scopes = ["notes:read", "notebooks:read", "notes:write"]) =>
      api(session(userId), "/api/tokens", { method: "POST", body: {
        name: `MCP · ${userId}`, resourceMode: "restricted", scopes, expiresAt: null,
        notebookResources: grants.map((grant) => ({ ...grant, includeDescendants: false })),
      } });
    const issueToken = async (userId: string, grants: Grant[], scopes?: string[]) => {
      const response = await createToken(userId, grants, scopes);
      assert.equal(response.status, 201, await response.clone().text());
      return await response.json() as { id: string; token: string };
    };
    const rpc = (bearer: string, method: string, params: unknown = {}) => app.request("https://note.example.com/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const tool = async (bearer: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
      const response = await rpc(bearer, "tools/call", { name, arguments: args });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json() as any).result;
    };
    const noteRow = (id: string) => db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Record<string, any> | undefined;
    // 读取 Markdown 时服务端可能补写块 ID；“未被修改”以位置、标题、正文文本和版本为准。
    const noteState = (id: string) => db.prepare(
      "SELECT notebookId, workspaceId, title, contentText, version, isTrashed FROM notes WHERE id = ?",
    ).get(id) as Record<string, any> | undefined;
    const setRole = (userId: string, role: string | null) => {
      db.prepare("DELETE FROM workspace_members WHERE workspaceId = ? AND userId = ?").run(WS, userId);
      if (role) db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS, userId, role);
    };

    assert.equal((await api(session("u-sysadmin"), "/api/mcp", { method: "PUT", body: {
      enabled: true, allowWrite: true, publicUrl: "https://note.example.com/mcp",
    } })).status, 200);

    await t.test("DCC-006: token notebook options group spaces and cap read-only team roles", async () => {
      const options = async (userId: string) => {
        const response = await api(session(userId), "/api/tokens/notebook-options");
        assert.equal(response.status, 200);
        return (await response.json() as any).notebooks as Array<Record<string, any>>;
      };
      const editor = await options("u-editor");
      const byId = new Map(editor.map((item) => [item.id, item]));
      assert.deepEqual(byId.get(personal.resourceId), { ...byId.get(personal.resourceId), workspaceId: null, shared: false, canWrite: true });
      for (const notebook of [docs, tech, secret]) {
        assert.equal(byId.get(notebook.resourceId)?.workspaceName, "产品研发团队");
        assert.equal(byId.get(notebook.resourceId)?.canWrite, true);
      }
      assert.equal(byId.get(ops.resourceId)?.workspaceName, "运营团队");
      assert.equal(byId.get(ops.resourceId)?.canWrite, false, "a viewer in another team only gets read options");
      assert.equal(editor.filter((item) => item.name === "项目文档").length, 2, "same-name notebooks stay distinguishable");
      for (const userId of ["u-viewer", "u-commenter"]) {
        const readonly = (await options(userId)).filter((item) => item.workspaceId === WS);
        assert.equal(readonly.length, 3);
        assert.ok(readonly.every((item) => item.canWrite === false), `${userId} options must be read-only`);
      }
      for (const userId of ["u-outsider", "u-sysadmin"]) {
        assert.equal((await options(userId)).some((item) => item.workspaceId === WS), false, `${userId} must not see team notebooks`);
      }
    });

    await t.test("DCC-006: token creation only delegates the caller's current team permission", async () => {
      for (const userId of ["u-viewer", "u-commenter"]) {
        assert.equal((await createToken(userId, [{ notebookId: docs.resourceId, permission: "write" }])).status, 403);
        assert.equal((await createToken(userId, [{ notebookId: docs.resourceId, permission: "read" }])).status, 201);
      }
      for (const userId of ["u-editor", "u-admin", "u-owner"]) {
        assert.equal((await createToken(userId, [{ notebookId: docs.resourceId, permission: "write" }])).status, 201);
      }
      for (const userId of ["u-outsider", "u-sysadmin"]) {
        assert.equal((await createToken(userId, [{ notebookId: docs.resourceId, permission: "read" }])).status, 403);
      }
      const editorToken = await issueToken("u-editor", [{ notebookId: docs.resourceId, permission: "read" }]);
      assert.equal((await api(editorToken.token, "/api/tokens", { method: "POST", body: {
        name: "self-escalation", resourceMode: "restricted", scopes: ["notes:write"],
        notebookResources: [{ notebookId: secret.resourceId, permission: "write" }],
      } })).status, 403, "a token cannot create or widen tokens");
      assert.equal((await api(editorToken.token, `/api/tokens/${editorToken.id}/resources`, { method: "PATCH", body: {
        resourceMode: "restricted", notebookResources: [{ notebookId: secret.resourceId, permission: "write" }],
      } })).status, 403, "a token cannot edit its own grant");
    });

    const editor = await issueToken("u-editor", [
      { notebookId: personal.resourceId, permission: "write" },
      { notebookId: docs.resourceId, permission: "write" },
      { notebookId: tech.resourceId, permission: "write" },
    ], ["notes:read", "notes:write", "notebooks:read", "notebooks:write"]);

    await t.test("DCC-006: an editor reads, searches and edits only the selected team notebooks", async () => {
      const catalog = json(await tool(editor.token, "nowen_list_notebooks")) as Array<Record<string, any>>;
      const team = catalog.filter((item) => item.workspaceId === WS);
      assert.deepEqual(team.map((item) => item.notebookId).sort(), [docs.resourceId, tech.resourceId].sort());
      assert.ok(team.every((item) => item.workspaceName === "产品研发团队" && item.permission === "write"));
      const sameName = catalog.filter((item) => item.notebookName === "项目文档");
      assert.deepEqual(sameName.map((item) => item.workspaceId).sort(), [WS, "personal"].sort());
      assert.doesNotMatch(JSON.stringify(catalog), /保密资料|运营资料/);

      const listed = json(await tool(editor.token, "nowen_list_notes")) as Array<{ id: string }>;
      assert.deepEqual(new Set(listed.map((note) => note.id)),
        new Set([personalNote.resourceId, docsNote.resourceId, treeNote.resourceId, "legacy-team-note"]));
      const teamOnly = json(await tool(editor.token, "nowen_list_notes", { workspaceId: WS })) as Array<{ id: string }>;
      assert.deepEqual(new Set(teamOnly.map((note) => note.id)), new Set([docsNote.resourceId, treeNote.resourceId, "legacy-team-note"]));

      const found = text(await tool(editor.token, "nowen_search", { query: "alphaword" }));
      assert.match(found, new RegExp(docsNote.resourceId));
      assert.match(found, new RegExp(personalNote.resourceId));
      assert.doesNotMatch(found, new RegExp(`${secretNote.resourceId}|${opsNote.resourceId}|保密计划|运营周报`));
      const teamFound = text(await tool(editor.token, "nowen_search", { query: "alphaword", workspaceId: WS }));
      assert.match(teamFound, new RegExp(docsNote.resourceId));
      assert.doesNotMatch(teamFound, new RegExp(personalNote.resourceId));
      const blocksFound = text(await tool(editor.token, "nowen_search", { query: "alphaword", level: "block" }));
      assert.doesNotMatch(blocksFound, /teamsecretbody|ops weekly/);

      assert.match(text(await tool(editor.token, "nowen_read_note", { noteId: docsNote.resourceId })), /team requirement alphaword/);
      for (const noteId of [secretNote.resourceId, opsNote.resourceId]) {
        const denied = await tool(editor.token, "nowen_read_note", { noteId });
        assert.equal(denied.isError, true);
        assert.doesNotMatch(text(denied), /teamsecretbody|ops weekly/);
      }
      assert.equal((await api(editor.token, `/api/notes/${secretNote.resourceId}`)).status, 403);

      const created = await tool(editor.token, "nowen_create_note", { notebookId: docs.resourceId, title: "AI 会议纪要", content: "created by mcp" });
      assert.equal(created.isError, undefined, text(created));
      const createdRow = db.prepare("SELECT id, workspaceId, notebookId FROM notes WHERE title = 'AI 会议纪要'").get() as Record<string, any>;
      assert.deepEqual({ workspaceId: createdRow.workspaceId, notebookId: createdRow.notebookId }, { workspaceId: WS, notebookId: docs.resourceId });
      const updated = await tool(editor.token, "nowen_update_note", { noteId: docsNote.resourceId, content: "team requirement alphaword revised" });
      assert.equal(updated.isError, undefined, text(updated));
      assert.match(String(noteRow(docsNote.resourceId)?.contentText), /team requirement alphaword revised/);
      for (const args of [
        { notebookId: secret.resourceId, title: "denied secret" },
        { notebookId: ops.resourceId, title: "denied ops" },
      ]) assert.equal((await tool(editor.token, "nowen_create_note", args)).isError, true);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM notes WHERE title LIKE 'denied %'").get() as { count: number }).count, 0);

      const preview = await tool(editor.token, "nowen_delete_note", { noteId: createdRow.id });
      assert.equal(preview.isError, undefined, text(preview));
      assert.match(text(preview), /未执行/);
      const before = noteRow(createdRow.id)!;
      const trashed = await tool(editor.token, "nowen_delete_note", {
        noteId: createdRow.id, dryRun: false, expectedVersion: before.version, confirmation: "MOVE_TO_TRASH",
      });
      assert.equal(trashed.isError, undefined, text(trashed));
      assert.equal(noteRow(createdRow.id)?.isTrashed, 1, "team notes are moved to the recycle bin, never purged");
    });

    await t.test("DCC-006: team knowledge-tree reads and writes stay inside one granted team", async () => {
      const ambiguous = await tool(editor.token, "nowen_get_knowledge_tree");
      assert.equal(ambiguous.isError, true);
      assert.match(text(ambiguous), new RegExp(`${WS}.*personal|personal.*${WS}`));
      const teamTree = json(await tool(editor.token, "nowen_get_knowledge_tree", { workspaceId: WS }));
      assert.equal(teamTree.workspaceId, WS);
      const ids = new Set((teamTree.nodes as Array<{ id: string }>).map((node) => node.id));
      assert.ok(ids.has(docs.id) && ids.has(tech.id) && ids.has(docsNote.id));
      assert.ok(!ids.has(secret.id) && !ids.has(secretNote.id), "ungranted team folders stay hidden");
      assert.doesNotMatch(JSON.stringify(teamTree), /保密/);

      const apply = async (bearer: string, args: Record<string, unknown>) => {
        const preview = await tool(bearer, "nowen_preview_knowledge_tree_change", args);
        if (preview.isError) return preview;
        const plan = json(preview);
        const confirmation = args.operation === "trash" ? "MOVE_TREE_TO_TRASH" : args.operation === "restore" ? "RESTORE_TREE" : "APPLY_TREE_CHANGE";
        return tool(bearer, "nowen_apply_knowledge_tree_change", {
          ...args, expectedRevision: plan.revision, confirmation,
          ...(plan.subtreeRevision ? { expectedSubtreeRevision: plan.subtreeRevision } : {}),
        });
      };
      const createdFolder = await apply(editor.token, { operation: "create", workspaceId: WS, parentId: docs.id, title: "AI 子目录", nodeType: "folder" });
      assert.equal(createdFolder.isError, undefined, text(createdFolder));
      assert.equal((db.prepare("SELECT workspaceId FROM notebooks WHERE name = 'AI 子目录'").get() as any)?.workspaceId, WS);
      const renamed = await apply(editor.token, { operation: "rename", workspaceId: WS, nodeId: treeNote.id, title: "目录练习 v2" });
      assert.equal(renamed.isError, undefined, text(renamed));
      assert.equal(noteRow(treeNote.resourceId)?.title, "目录练习 v2");
      // 默认团队规则：编辑者可以创建和改名，移动、删除需要团队管理员。
      assert.equal((await apply(editor.token, { operation: "move", workspaceId: WS, nodeId: treeNote.id, parentId: tech.id })).isError, true);
      assert.equal((await apply(editor.token, { operation: "trash", workspaceId: WS, nodeId: treeNote.id })).isError, true);
      // 跨空间：团队节点不能当作个人节点操作，也不能移进个人目录或未授权的团队目录。
      assert.equal((await apply(editor.token, { operation: "rename", nodeId: treeNote.id, title: "wrong space" })).isError, true);
      assert.equal((await apply(editor.token, { operation: "move", workspaceId: WS, nodeId: treeNote.id, parentId: personal.id })).isError, true);
      assert.equal((await apply(editor.token, { operation: "create", workspaceId: WS, parentId: secret.id, title: "denied", nodeType: "folder" })).isError, true);
      assert.equal(noteRow(treeNote.resourceId)?.notebookId, docs.resourceId);
      const forged = await api(editor.token, `/api/knowledge-tree/nodes/${encodeURIComponent(treeNote.id)}?workspaceId=personal`, {
        method: "PATCH", body: { title: "forged", expectedUpdatedAt: "x", expectedTitle: "x", expectedParentId: null, expectedChildCount: 0 },
      });
      assert.equal(forged.status, 403);
      assert.equal((await api(editor.token, `/api/knowledge-tree/batch/delete?workspaceId=${WS}`, { method: "POST", body: { nodeIds: [docs.id] } })).status, 403);

      // 目录结构写入需要 notebooks:write（快速连接默认不授予，只能在开发者令牌页开启）。
      const admin = await issueToken("u-admin", [
        { notebookId: docs.resourceId, permission: "write" },
        { notebookId: tech.resourceId, permission: "write" },
      ], ["notes:read", "notes:write", "notebooks:read", "notebooks:write"]);
      const moved = await apply(admin.token, { operation: "move", workspaceId: WS, nodeId: treeNote.id, parentId: tech.id });
      assert.equal(moved.isError, undefined, text(moved));
      assert.equal(noteRow(treeNote.resourceId)?.notebookId, tech.resourceId);
      const trashed = await apply(admin.token, { operation: "trash", workspaceId: WS, nodeId: treeNote.id });
      assert.equal(trashed.isError, undefined, text(trashed));
      assert.equal(noteRow(treeNote.resourceId)?.isTrashed, 1);
      const restored = await apply(admin.token, { operation: "restore", workspaceId: WS, nodeId: treeNote.id });
      assert.equal(restored.isError, undefined, text(restored));
      assert.equal(noteRow(treeNote.resourceId)?.isTrashed, 0);
    });

    await t.test("DCC-006: cross-space notebook creation and note moves are rejected", async () => {
      const crossCreate = await api(editor.token, "/api/notebooks", { method: "POST", body: { name: "personal under team", parentId: docs.resourceId } });
      assert.equal(crossCreate.status, 403);
      assert.equal(((await crossCreate.json()) as any).code, "API_TOKEN_CROSS_SPACE_DENIED");
      assert.equal(db.prepare("SELECT id FROM notebooks WHERE name = 'personal under team'").get(), undefined);
      const childCreate = await tool(editor.token, "nowen_create_notebook", { name: "团队子笔记本", parentId: docs.resourceId });
      assert.equal(childCreate.isError, undefined, text(childCreate));
      assert.equal((db.prepare("SELECT workspaceId FROM notebooks WHERE name = '团队子笔记本'").get() as any)?.workspaceId, WS);
      const before = noteState("legacy-team-note")!;
      const moved = await tool(editor.token, "nowen_move_note", {
        noteId: "legacy-team-note", targetNotebookId: personal.resourceId, dryRun: false, expectedVersion: before.version,
      });
      assert.equal(moved.isError, true);
      assert.deepEqual(noteState("legacy-team-note"), before);
    });

    await t.test("DCC-006: backlinks, link resolution, graph and attachments do not leak ungranted notes", async () => {
      db.prepare(`INSERT INTO note_links (id, userId, sourceNoteId, targetNoteId, linkType, linkText, excerpt)
        VALUES ('link-secret', 'u-editor', ?, ?, 'note', '保密计划', ?)`).run(secretNote.resourceId, docsNote.resourceId, SECRET_BODY);
      const backlinks = await api(editor.token, `/api/notes/${docsNote.resourceId}/backlinks`);
      assert.equal(backlinks.status, 200);
      assert.doesNotMatch(await backlinks.text(), /保密计划|teamsecretbody/);
      assert.doesNotMatch(text(await tool(editor.token, "nowen_get_backlinks", { noteId: docsNote.resourceId })), /保密计划|teamsecretbody/);
      assert.equal((await api(editor.token, `/api/blocks/resolve?link=${encodeURIComponent(`note:${secretNote.resourceId}`)}`)).status, 403);
      assert.equal((await tool(editor.token, "nowen_resolve_link", { link: `note:${secretNote.resourceId}` })).isError, true);
      const graph = await api(editor.token, "/api/blocks/graph");
      assert.doesNotMatch(await graph.text(), /保密计划/);

      db.prepare(`INSERT INTO attachments (id, noteId, userId, workspaceId, filename, mimeType, size, path)
        VALUES ('att-secret', ?, 'u-owner', ?, 'secret.pdf', 'application/pdf', 1, 'secret.pdf')`).run(secretNote.resourceId, WS);
      assert.equal((await api(editor.token, "/api/files/att-secret")).status, 403);
      assert.equal((await api(session("u-editor"), "/api/files/att-secret")).status, 200, "the member UI can still open the file");
    });

    await t.test("DCC-006: read-only roles cannot write even with a forged write grant", async () => {
      for (const userId of ["u-viewer", "u-commenter"]) {
        const token = await issueToken(userId, [{ notebookId: docs.resourceId, permission: "read" }]);
        db.prepare("UPDATE api_token_resources SET permission = 'write' WHERE tokenId = ?").run(token.id);
        assert.match(text(await tool(token.token, "nowen_read_note", { noteId: docsNote.resourceId })), /team requirement alphaword revised/);
        const catalog = json(await tool(token.token, "nowen_list_notebooks")) as Array<Record<string, any>>;
        assert.equal(catalog.find((item) => item.notebookId === docs.resourceId)?.permission, "read");
        const before = noteState(docsNote.resourceId);
        assert.equal((await tool(token.token, "nowen_update_note", { noteId: docsNote.resourceId, content: "viewer edit" })).isError, true);
        assert.equal((await tool(token.token, "nowen_create_note", { notebookId: docs.resourceId, title: `${userId} denied` })).isError, true);
        assert.deepEqual(noteState(docsNote.resourceId), before);
        assert.equal(db.prepare("SELECT id FROM notes WHERE title = ?").get(`${userId} denied`), undefined);
      }
    });

    await t.test("DCC-006: removal, downgrade and owner/admin bypasses take effect on the next request", async () => {
      const legacyBefore = noteState("legacy-team-note");
      setRole("u-editor", null);
      try {
        const catalog = json(await tool(editor.token, "nowen_list_notebooks")) as Array<Record<string, any>>;
        assert.equal(catalog.some((item) => item.workspaceId === WS), false);
        assert.ok(catalog.some((item) => item.notebookId === personal.resourceId), "personal grants keep working");
        assert.equal((await tool(editor.token, "nowen_read_note", { noteId: "legacy-team-note" })).isError, true,
          "owner-field fallback must not survive team removal");
        assert.equal((await tool(editor.token, "nowen_update_note", { noteId: "legacy-team-note", content: "after removal" })).isError, true);
        assert.deepEqual(noteState("legacy-team-note"), legacyBefore);
        assert.doesNotMatch(text(await tool(editor.token, "nowen_search", { query: "alphaword" })), /legacy-team-note|需求说明/);
        assert.equal(((json(await tool(editor.token, "nowen_get_knowledge_tree", { workspaceId: WS })) as any).nodes as unknown[]).length, 0);
      } finally {
        setRole("u-editor", "editor");
      }
      assert.match(text(await tool(editor.token, "nowen_read_note", { noteId: "legacy-team-note" })), /legacy alphaword api/);

      setRole("u-editor", "viewer");
      try {
        assert.match(text(await tool(editor.token, "nowen_read_note", { noteId: "legacy-team-note" })), /legacy alphaword api/);
        assert.equal((await tool(editor.token, "nowen_update_note", { noteId: "legacy-team-note", content: "downgraded" })).isError, true);
        assert.deepEqual(noteState("legacy-team-note"), legacyBefore);
      } finally {
        setRole("u-editor", "editor");
      }

      // workspaces.ownerId 让界面仍把 owner 视为管理员，但 Token 必须要求真实成员身份。
      const owner = await issueToken("u-owner", [{ notebookId: docs.resourceId, permission: "write" }]);
      setRole("u-owner", null);
      try {
        assert.equal((await api(session("u-owner"), `/api/notes/${docsNote.resourceId}`)).status, 200);
        assert.equal((await api(owner.token, `/api/notes/${docsNote.resourceId}`)).status, 403);
        assert.equal((await tool(owner.token, "nowen_read_note", { noteId: docsNote.resourceId })).isError, true);
      } finally {
        setRole("u-owner", "owner");
      }
      db.prepare(`INSERT INTO api_tokens (id, userId, name, tokenHash, scopes, resourceMode)
        VALUES ('sysadmin-token', 'u-sysadmin', 'forged', ?, '["notes:read"]', 'restricted')`)
        .run((await import("../src/lib/api-tokens")).hashApiToken("nkn_team-space-sysadmin-forged-grant"));
      db.prepare(`INSERT INTO api_token_resources (id, tokenId, resourceType, resourceId, permission)
        VALUES ('sysadmin-grant', 'sysadmin-token', 'notebook', ?, 'write')`).run(docs.resourceId);
      assert.equal((await api("nkn_team-space-sysadmin-forged-grant", `/api/notes/${docsNote.resourceId}`)).status, 403,
        "system administrators do not bypass team membership through a token");
    });

    await t.test("DCC-006: cross-user and cross-team grants are denied", async () => {
      const outsider = await issueToken("u-outsider", [{ notebookId: ops.resourceId, permission: "write" }]);
      db.prepare(`INSERT INTO api_token_resources (id, tokenId, resourceType, resourceId, permission)
        VALUES ('outsider-forged', ?, 'notebook', ?, 'write')`).run(outsider.id, docs.resourceId);
      assert.equal((await api(outsider.token, `/api/notes/${docsNote.resourceId}`)).status, 403);
      assert.equal((await api(outsider.token, `/api/notes/${personalNote.resourceId}`)).status, 403);
      assert.doesNotMatch(text(await tool(outsider.token, "nowen_list_notebooks")), /项目文档|技术方案/);
      const opsReader = await issueToken("u-editor", [{ notebookId: ops.resourceId, permission: "read" }]);
      assert.match(text(await tool(opsReader.token, "nowen_read_note", { noteId: opsNote.resourceId })), /ops weekly/);
      assert.equal((await api(opsReader.token, `/api/notes/${docsNote.resourceId}`)).status, 403);
      // 并发请求之间不串用身份：交替发起的团队 / 跨团队调用各自只看到自己的授权。
      const concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        tool(index % 2 ? editor.token : outsider.token, "nowen_list_notebooks")));
      concurrent.forEach((result, index) => {
        const output = text(result);
        if (index % 2) {
          assert.match(output, new RegExp(docs.resourceId));
          assert.doesNotMatch(output, new RegExp(ops.resourceId));
        } else {
          assert.match(output, new RegExp(ops.resourceId));
          assert.doesNotMatch(output, new RegExp(`${docs.resourceId}|${personal.resourceId}`));
        }
      });
    });

    await t.test("DCC-006: standalone stdio MCP uses the same server-side team grants", async () => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
      if (!server.listening) await once(server, "listening");
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const stdio = await startStdioMcp(baseUrl, editor.token);
      try {
        const catalog = json(await stdio.call("nowen_list_notebooks")) as Array<Record<string, any>>;
        assert.ok(catalog.some((item) => item.notebookId === docs.resourceId && item.workspaceId === WS && item.permission === "write"));
        assert.doesNotMatch(JSON.stringify(catalog), /保密资料/);
        assert.match(text(await stdio.call("nowen_read_note", { noteId: "legacy-team-note" })), /legacy alphaword api/);
        const created = await stdio.call("nowen_create_note", { notebookId: tech.resourceId, title: "stdio 团队笔记", content: "stdio body" });
        assert.equal(created.isError, undefined, text(created));
        assert.equal((db.prepare("SELECT workspaceId FROM notes WHERE title = 'stdio 团队笔记'").get() as any)?.workspaceId, WS);
        assert.equal((await stdio.call("nowen_read_note", { noteId: secretNote.resourceId })).isError, true);
        setRole("u-editor", null);
        try {
          assert.equal((await stdio.call("nowen_read_note", { noteId: "legacy-team-note" })).isError, true);
        } finally {
          setRole("u-editor", "editor");
        }
      } finally {
        await stdio.close();
      }
    });

    await t.test("DCC-006: revoked, expired and deleted team tokens stop immediately", async () => {
      const temporary = await issueToken("u-editor", [{ notebookId: docs.resourceId, permission: "read" }]);
      assert.equal((await rpc(temporary.token, "tools/list")).status, 200);
      db.prepare("UPDATE api_tokens SET expiresAt = '2000-01-01T00:00:00Z' WHERE id = ?").run(temporary.id);
      assert.equal((await rpc(temporary.token, "tools/list")).status, 401);
      assert.equal((await api(temporary.token, `/api/notes/${docsNote.resourceId}`)).status, 401);
      db.prepare("UPDATE api_tokens SET expiresAt = NULL WHERE id = ?").run(temporary.id);
      assert.equal((await api(session("u-editor"), `/api/tokens/${temporary.id}`, { method: "DELETE" })).status, 200);
      assert.equal((await rpc(temporary.token, "tools/list")).status, 401);
      assert.equal((await api(session("u-editor"), `/api/tokens/${temporary.id}/permanent`, { method: "DELETE" })).status, 200);
      assert.equal((await api(temporary.token, `/api/notes/${docsNote.resourceId}`)).status, 401);
    });

    await t.test("DCC-006: token audit logs record space and result without credentials or note bodies", async () => {
      const rows = db.prepare("SELECT level, details FROM audit_logs WHERE action = 'api_token_request'").all() as Array<{ level: string; details: string }>;
      const entries = rows.map((row) => ({ level: row.level, ...JSON.parse(row.details) }));
      assert.ok(entries.some((entry) => entry.tokenId === editor.id && entry.result === "allowed" && entry.spaces.includes(WS) && entry.method === "PUT"));
      assert.ok(entries.some((entry) => entry.tokenId === editor.id && entry.result === "allowed" && entry.spaces.includes(WS) && entry.method === "GET"),
        "team reads are audited");
      assert.ok(entries.some((entry) => entry.result === "denied" && entry.level === "warn" && entry.spaces.includes(WS)));
      const serialized = JSON.stringify(rows);
      assert.doesNotMatch(serialized, /nkn_|teamsecretbody|team requirement alphaword|created by mcp/);
      const created = db.prepare("SELECT details FROM audit_logs WHERE action = 'api_token_created' AND targetId = ?").get(editor.id) as { details: string };
      assert.deepEqual(JSON.parse(created.details).spaces, ["personal", WS]);
    });
  } finally {
    server?.close();
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
