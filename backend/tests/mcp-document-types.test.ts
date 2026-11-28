import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-mcp-doctypes-"));
process.env.DB_PATH = path.join(dir, "doctypes.db");
process.env.ELECTRON_USER_DATA = dir;

type ToolResult = { content?: Array<{ text?: string }>; isError?: boolean };
const text = (res: ToolResult) => (res.content || []).map((item) => item.text || "").join("\n");

test("MCP supports CRUD for Word, RichText, TXT, PPT, Excel, MindMap and KnowledgeTree while enforcing PAT scope and encryption safety", async (t) => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { initApiTokensTable, hashApiToken, resolveApiToken } = await import("../src/lib/api-tokens.js");
  const { initAuditTables } = await import("../src/services/audit.js");
  const { enforceApiTokenAccess } = await import("../src/middleware/api-token-resource-scope.js");
  const { createEmbeddedMcpRouter, createMcpSettingsRouter } = await import("../src/mcp.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const { default: notebooks } = await import("../src/routes/notebooks.js");
  const { default: notes } = await import("../src/routes/notes.js");
  const { default: excels } = await import("../src/routes/excels.js");
  const { default: mindmaps } = await import("../src/routes/mindmaps.js");
  const { default: tree } = await import("../src/routes/knowledge-tree.js");

  const db = getDb();
  try {
    initApiTokensTable(db);
    initAuditTables();

    db.exec(`
      INSERT INTO users (id, username, passwordHash, role) VALUES
        ('doc-owner', 'doc-owner', 'hash', 'admin'),
        ('doc-other', 'doc-other', 'hash', 'user');
      INSERT INTO workspaces (id, name, ownerId) VALUES
        ('ws-doc', 'Doc Team', 'doc-other');
      INSERT INTO workspace_members (workspaceId, userId, role) VALUES
        ('ws-doc', 'doc-other', 'owner'),
        ('ws-doc', 'doc-owner', 'editor');
    `);

    const nbWrite = createKnowledgeChild({ actorUserId: "doc-owner", workspaceId: null, parentId: null, nodeType: "folder", title: "可写目录", db });
    const nbRead = createKnowledgeChild({ actorUserId: "doc-owner", workspaceId: null, parentId: null, nodeType: "folder", title: "只读目录", db });
    const nbDenied = createKnowledgeChild({ actorUserId: "doc-owner", workspaceId: null, parentId: null, nodeType: "folder", title: "未授权目录", db });
    const nbOther = createKnowledgeChild({ actorUserId: "doc-other", workspaceId: null, parentId: null, nodeType: "folder", title: "他人目录", db });
    const nbTeam = createKnowledgeChild({ actorUserId: "doc-other", workspaceId: "ws-doc", parentId: null, nodeType: "folder", title: "团队目录", db });

    // 预置加密笔记（复用官方合法信封夹具）、只读目录中的 Excel 与 MindMap、未授权目录中的 MindMap、根级无归属 MindMap
    const { envelope } = JSON.parse(
      fs.readFileSync(path.resolve("..", "frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json"), "utf8"),
    );
    const encryptedContent = JSON.stringify(envelope);
    db.prepare(`
      INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, note_type)
      VALUES ('enc-note-1', 'doc-owner', ?, '私密加密笔记', ?, '', 'encrypted-note-v1', 'normal')
    `).run(nbWrite.resourceId, encryptedContent);

    const readonlyExcel = createKnowledgeChild({ actorUserId: "doc-owner", workspaceId: null, parentId: nbRead.id, nodeType: "excel", title: "只读表格", db });
    const readonlyMap = createKnowledgeChild({ actorUserId: "doc-owner", workspaceId: null, parentId: nbRead.id, nodeType: "mindmap", title: "只读导图", db });
    const deniedMap = createKnowledgeChild({ actorUserId: "doc-owner", workspaceId: null, parentId: nbDenied.id, nodeType: "mindmap", title: "隐藏导图", db });
    const otherMap = createKnowledgeChild({ actorUserId: "doc-other", workspaceId: null, parentId: nbOther.id, nodeType: "mindmap", title: "他人导图", db });
    const teamMap = createKnowledgeChild({ actorUserId: "doc-other", workspaceId: "ws-doc", parentId: nbTeam.id, nodeType: "mindmap", title: "团队导图", db });
    // 根级无笔记本归属的导图
    db.prepare("INSERT INTO mindmaps (id, userId, workspaceId, title, data) VALUES ('root-map-1', 'doc-owner', NULL, '根级导图', '{\"root\":{\"id\":\"root\",\"text\":\"根级导图\",\"children\":[]}}')").run();

    // Token 1: 类似“连接 AI 助手”快速连接的受限 Token（仅 notes:read/write + notebooks:read，无 notebooks:write）
    const quickToken = "nkn_doctypes-quick-connect-token-123456";
    db.prepare(`INSERT INTO api_tokens (id, userId, name, tokenHash, scopes, resourceMode) VALUES (?, 'doc-owner', 'Quick', ?, ?, 'restricted')`)
      .run("tok-quick", hashApiToken(quickToken), JSON.stringify(["notes:read", "notes:write", "notebooks:read"]));
    db.prepare(`INSERT INTO api_token_resources (id, tokenId, resourceType, resourceId, permission, includeDescendants) VALUES
      ('g-w', 'tok-quick', 'notebook', ?, 'write', 1),
      ('g-r', 'tok-quick', 'notebook', ?, 'read', 1)`).run(nbWrite.resourceId, nbRead.resourceId);

    // Token 2: 带 notebooks:write 的开发者受限 Token（用于测试知识树多类型创建与管理）
    const treeToken = "nkn_doctypes-tree-admin-token-123456789";
    db.prepare(`INSERT INTO api_tokens (id, userId, name, tokenHash, scopes, resourceMode) VALUES (?, 'doc-owner', 'Tree', ?, ?, 'restricted')`)
      .run("tok-tree", hashApiToken(treeToken), JSON.stringify(["notes:read", "notes:write", "notebooks:read", "notebooks:write"]));
    db.prepare(`INSERT INTO api_token_resources (id, tokenId, resourceType, resourceId, permission, includeDescendants) VALUES
      ('gt-w', 'tok-tree', 'notebook', ?, 'write', 1)`).run(nbWrite.resourceId);

    // Token 3: unrestricted Token（验证团队导图写隔离和永久删除拦截）
    const unrestrictedToken = "nkn_doctypes-unrestricted-token-123456";
    db.prepare(`INSERT INTO api_tokens (id, userId, name, tokenHash, scopes, resourceMode) VALUES (?, 'doc-owner', 'Legacy', ?, ?, 'unrestricted')`)
      .run("tok-legacy", hashApiToken(unrestrictedToken), JSON.stringify(["notes:read", "notes:write", "notebooks:read", "notebooks:write"]));

    const app = new Hono();
    app.route("/mcp", createEmbeddedMcpRouter((req) => app.fetch(req)));
    app.use("/api/*", async (c, next) => {
      for (const h of ["X-User-Id", "X-Auth-Mode", "X-Api-Token-Id", "X-Api-Scopes", "X-Api-Resource-Mode", "X-Api-Allowed-Notebook-Ids"]) {
        c.req.raw.headers.delete(h);
      }
      const bearer = (c.req.header("Authorization") || "").slice(7);
      if (bearer === "admin-session") {
        c.req.raw.headers.set("X-User-Id", "doc-owner");
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
    app.route("/api/excels", excels);
    app.route("/api/mindmaps", mindmaps);
    app.route("/api/knowledge-tree/", tree);

    assert.equal((await app.request("http://localhost/api/mcp", {
      method: "PUT",
      headers: { Authorization: "Bearer admin-session", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, allowWrite: true, publicUrl: "https://note.example.com/mcp" }),
    })).status, 200);

    const tool = async (bearer: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
      const res = await app.request("https://note.example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json() as any).result;
    };

    await t.test("Word, RichText, TXT and PPT CRUD preserve types and formats without downgrading to markdown", async () => {
      // 1. Word 文档
      const wordRes = await tool(quickToken, "nowen_create_note", {
        notebookId: nbWrite.resourceId,
        title: "Word 方案",
        noteType: "word",
        content: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Word 正文" }] }] }),
      });
      assert.equal(wordRes.isError, undefined, text(wordRes));
      const wordId = JSON.parse(text(wordRes).split("\n").slice(1).join("\n")).id;
      const wordRead = JSON.parse(text(await tool(quickToken, "nowen_read_note", { noteId: wordId })));
      assert.equal(wordRead.noteType, "word");
      assert.equal(wordRead.contentFormat, "tiptap-json");

      // 更新时不传 contentFormat，必须保留 tiptap-json 而非退化为 markdown
      const wordUpd = await tool(quickToken, "nowen_update_note", {
        noteId: wordId,
        content: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Word 更新后" }] }] }),
      });
      assert.equal(wordUpd.isError, undefined, text(wordUpd));
      const wordRow = db.prepare("SELECT note_type, contentFormat, contentText FROM notes WHERE id = ?").get(wordId) as any;
      assert.equal(wordRow.note_type, "word");
      assert.equal(wordRow.contentFormat, "tiptap-json");
      assert.match(wordRow.contentText, /Word 更新后/);

      // 2. 纯文本 TXT
      const txtRes = await tool(quickToken, "nowen_create_note", {
        notebookId: nbWrite.resourceId,
        title: "日志.txt",
        contentFormat: "plaintext",
        content: "第一行\n第二行",
      });
      assert.equal(txtRes.isError, undefined, text(txtRes));
      const txtId = JSON.parse(text(txtRes).split("\n").slice(1).join("\n")).id;
      const txtUpd = await tool(quickToken, "nowen_update_note", { noteId: txtId, content: "第一行\n第二行\n第三行" });
      assert.equal(txtUpd.isError, undefined, text(txtUpd));
      assert.equal((db.prepare("SELECT contentFormat FROM notes WHERE id = ?").get(txtId) as any).contentFormat, "plaintext");

      // 3. PPT 演示文稿
      const pptRes = await tool(quickToken, "nowen_create_note", {
        notebookId: nbWrite.resourceId,
        title: "产品发布会",
        noteType: "ppt",
      });
      assert.equal(pptRes.isError, undefined, text(pptRes));
      const pptId = JSON.parse(text(pptRes).split("\n").slice(1).join("\n")).id;
      const pptRead = JSON.parse(text(await tool(quickToken, "nowen_read_note", { noteId: pptId, mode: "markdown" })));
      assert.equal(pptRead.noteType, "ppt");
      assert.equal(pptRead.contentFormat, "ppt-json");
      const newDeck = JSON.stringify({
        version: 1, title: "产品发布会 v2", theme: "classic",
        slides: [{ id: "s1", layout: "title", title: "欢迎", subtitle: "Nowen MCP", bullets: ["支持多文档"], notes: "" }],
      });
      const pptUpd = await tool(quickToken, "nowen_update_note", { noteId: pptId, title: "产品发布会 v2", content: newDeck });
      assert.equal(pptUpd.isError, undefined, text(pptUpd));
      const pptRow = db.prepare("SELECT note_type, contentFormat, contentText FROM notes WHERE id = ?").get(pptId) as any;
      assert.equal(pptRow.note_type, "ppt");
      assert.equal(pptRow.contentFormat, "ppt-json");
      assert.match(pptRow.contentText, /支持多文档/);

      // 列表按 noteType 筛选
      const pptList = JSON.parse(text(await tool(quickToken, "nowen_list_notes", { noteType: "ppt" })));
      assert.deepEqual(pptList.map((n: any) => n.id), [pptId]);

      // 4. 加密笔记防护：不暴露密文、拒绝明文覆盖
      const encRead = JSON.parse(text(await tool(quickToken, "nowen_read_note", { noteId: "enc-note-1", mode: "markdown" })));
      assert.equal(encRead.encrypted, true);
      assert.equal(encRead.content, undefined);
      assert.doesNotMatch(JSON.stringify(encRead), new RegExp(envelope.payload.ciphertext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const encBefore = db.prepare("SELECT content, contentFormat, version FROM notes WHERE id = 'enc-note-1'").get();
      const encUpd = await tool(quickToken, "nowen_update_note", { noteId: "enc-note-1", content: "试图明文化" });
      assert.equal(encUpd.isError, true);
      assert.deepEqual(db.prepare("SELECT content, contentFormat, version FROM notes WHERE id = 'enc-note-1'").get(), encBefore);
    });

    await t.test("Excel CRUD enforces optimistic locking, PAT scope and recoverable trash", async () => {
      const createdRes = await tool(quickToken, "nowen_create_excel", {
        notebookId: nbWrite.resourceId,
        title: "预算表",
        sheets: [{ name: "2026", rows: [["项目", "金额"], ["服务器", 1200]] }],
      });
      assert.equal(createdRes.isError, undefined, text(createdRes));
      const created = JSON.parse(text(createdRes).split("\n").slice(1).join("\n"));
      assert.equal(created.revision, 1);

      const list = JSON.parse(text(await tool(quickToken, "nowen_list_excels")));
      assert.ok(list.some((x: any) => x.noteId === created.noteId));
      assert.ok(list.some((x: any) => x.noteId === readonlyExcel.resourceId));

      const read = JSON.parse(text(await tool(quickToken, "nowen_read_excel", { noteId: created.noteId })));
      assert.equal(read.revision, 1);
      assert.equal(read.sheets[0].previewRows[1].cells["1"], 1200);

      // 禁止通过 nowen_update_note 覆盖 Excel 正文
      const badNoteEdit = await tool(quickToken, "nowen_update_note", { noteId: created.noteId, content: "破坏" });
      assert.equal(badNoteEdit.isError, true);

      // 更新单元格和标题
      const updatedRes = await tool(quickToken, "nowen_update_excel", {
        noteId: created.noteId,
        title: "2026 预算表",
        expectedRevision: 1,
        cellUpdates: [{ sheetName: "2026", row: 1, col: 1, value: 1500 }],
      });
      assert.equal(updatedRes.isError, undefined, text(updatedRes));
      const readAfter = JSON.parse(text(await tool(quickToken, "nowen_read_excel", { noteId: created.noteId })));
      assert.equal(readAfter.revision, 2);
      assert.equal(readAfter.title, "2026 预算表");
      assert.equal(readAfter.sheets[0].previewRows[1].cells["1"], 1500);

      // 过时 expectedRevision 必须 409 拒绝
      const stale = await tool(quickToken, "nowen_update_excel", {
        noteId: created.noteId,
        expectedRevision: 1,
        cellUpdates: [{ sheetName: "2026", row: 1, col: 1, value: 9999 }],
      });
      assert.equal(stale.isError, true);
      assert.match(text(stale), /409|EXCEL_CONFLICT/);

      // 越权拒绝：只读目录不可写，未授权目录不可建
      assert.equal((await tool(quickToken, "nowen_update_excel", {
        noteId: readonlyExcel.resourceId,
        cellUpdates: [{ row: 0, col: 0, value: "denied" }],
      })).isError, true);
      assert.equal((await tool(quickToken, "nowen_create_excel", {
        notebookId: nbDenied.resourceId,
        title: "越权表",
      })).isError, true);

      // 两步预览 + 软删除到回收站
      const preview = await tool(quickToken, "nowen_delete_excel", { noteId: created.noteId });
      assert.equal(preview.isError, undefined, text(preview));
      assert.match(text(preview), /未执行/);
      const currentVersion = (db.prepare("SELECT version FROM notes WHERE id = ?").get(created.noteId) as any).version;
      const trashed = await tool(quickToken, "nowen_delete_excel", {
        noteId: created.noteId,
        dryRun: false,
        expectedVersion: currentVersion,
        confirmation: "MOVE_TO_TRASH",
      });
      assert.equal(trashed.isError, undefined, text(trashed));
      assert.equal((db.prepare("SELECT isTrashed FROM notes WHERE id = ?").get(created.noteId) as any).isTrashed, 1);
    });

    await t.test("MindMap CRUD enforces tree-ancestor notebook grants, optimistic lock and no permanent deletion", async () => {
      // restricted Token 列表仅看到授权笔记本内的导图（含只读），看不到隐藏/根级/他人/团队导图
      const listed = JSON.parse(text(await tool(quickToken, "nowen_list_mindmaps")));
      assert.deepEqual(listed.map((m: any) => m.id), [readonlyMap.resourceId]);

      // restricted Token 不可不带 notebookId 创建，也不可在只读/未授权笔记本创建
      assert.equal((await tool(quickToken, "nowen_create_mindmap", { title: "无目录导图" })).isError, true);
      assert.equal((await tool(quickToken, "nowen_create_mindmap", { notebookId: nbRead.resourceId, title: "只读创建" })).isError, true);
      assert.equal((await tool(quickToken, "nowen_create_mindmap", { notebookId: nbDenied.resourceId, title: "未授权创建" })).isError, true);

      // 在可写笔记本创建思维导图
      const createdRes = await tool(quickToken, "nowen_create_mindmap", {
        notebookId: nbWrite.resourceId,
        title: "架构演进",
        data: { root: { id: "root", text: "架构演进", children: [{ id: "c1", text: "MCP 多类型", children: [] }] } },
      });
      assert.equal(createdRes.isError, undefined, text(createdRes));
      const created = JSON.parse(text(createdRes).split("\n").slice(1).join("\n"));
      assert.equal(created.notebookId, nbWrite.resourceId);

      const read = JSON.parse(text(await tool(quickToken, "nowen_read_mindmap", { mindmapId: created.id })));
      assert.equal(read.data.root.children[0].text, "MCP 多类型");

      // 更新思维导图 & 乐观锁校验
      const upd = await tool(quickToken, "nowen_update_mindmap", {
        mindmapId: created.id,
        title: "架构演进 v2",
        expectedUpdatedAt: read.updatedAt,
        data: { root: { id: "root", text: "架构演进 v2", children: [{ id: "c1", text: "MCP 多类型", children: [] }, { id: "c2", text: "权限校验", children: [] }] } },
      });
      assert.equal(upd.isError, undefined, text(upd));
      const stale = await tool(quickToken, "nowen_update_mindmap", {
        mindmapId: created.id,
        title: "过时写入",
        expectedUpdatedAt: "2000-01-01 00:00:00",
      });
      assert.equal(stale.isError, true);
      assert.match(text(stale), /409|MINDMAP_CONFLICT/);

      // 越权拒绝：根级/未授权/他人/只读导图
      for (const id of [deniedMap.resourceId, otherMap.resourceId, "root-map-1"]) {
        assert.equal((await tool(quickToken, "nowen_read_mindmap", { mindmapId: id })).isError, true);
      }
      assert.equal((await tool(quickToken, "nowen_update_mindmap", { mindmapId: readonlyMap.resourceId, title: "篡改只读" })).isError, true);

      // PAT 永远不能调永久删除或旧版 move 接口；unrestricted Token 不可写团队导图
      assert.equal((await app.request(`http://localhost/api/mindmaps/${created.id}/permanent`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${unrestrictedToken}` },
      })).status, 403);
      assert.equal((await app.request(`http://localhost/api/mindmaps/${teamMap.resourceId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${unrestrictedToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "团队篡改" }),
      })).status, 403);

      // 两步预览 + 软删除到回收站
      const delPreview = await tool(quickToken, "nowen_delete_mindmap", { mindmapId: created.id });
      assert.equal(delPreview.isError, undefined, text(delPreview));
      assert.match(text(delPreview), /未执行/);
      const latest = db.prepare("SELECT updatedAt FROM mindmaps WHERE id = ?").get(created.id) as { updatedAt: string };
      const deleted = await tool(quickToken, "nowen_delete_mindmap", {
        mindmapId: created.id,
        dryRun: false,
        expectedUpdatedAt: latest.updatedAt,
        confirmation: "MOVE_TO_TRASH",
      });
      assert.equal(deleted.isError, undefined, text(deleted));
      const treeRow = db.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE resourceType = 'mindmap' AND resourceId = ?").get(created.id) as any;
      assert.equal(treeRow.isDeleted, 1);
    });

    await t.test("Knowledge tree tools create multi-type nodes and manage mindmap nodes safely", async () => {
      const applyTree = async (args: Record<string, unknown>) => {
        const preview = await tool(treeToken, "nowen_preview_knowledge_tree_change", args);
        assert.equal(preview.isError, undefined, text(preview));
        const plan = JSON.parse(text(preview));
        const confirmation = args.operation === "trash" ? "MOVE_TREE_TO_TRASH" : args.operation === "restore" ? "RESTORE_TREE" : "APPLY_TREE_CHANGE";
        return tool(treeToken, "nowen_apply_knowledge_tree_change", {
          ...args,
          expectedRevision: plan.revision,
          confirmation,
          ...(plan.subtreeRevision ? { expectedSubtreeRevision: plan.subtreeRevision } : {}),
        });
      };

      const createdWord = await applyTree({ operation: "create", parentId: nbWrite.id, title: "树建Word", nodeType: "word" });
      assert.equal(createdWord.isError, undefined, text(createdWord));
      assert.equal(JSON.parse(text(createdWord)).result.noteType, "word");

      const createdPpt = await applyTree({ operation: "create", parentId: nbWrite.id, title: "树建PPT", nodeType: "ppt" });
      assert.equal(createdPpt.isError, undefined, text(createdPpt));
      assert.equal(JSON.parse(text(createdPpt)).result.noteType, "ppt");
      assert.equal(JSON.parse(text(createdPpt)).result.contentFormat, "ppt-json");

      const createdTxt = await applyTree({ operation: "create", parentId: nbWrite.id, title: "树建TXT", nodeType: "note", contentFormat: "plaintext" });
      assert.equal(createdTxt.isError, undefined, text(createdTxt));
      assert.equal(JSON.parse(text(createdTxt)).result.contentFormat, "plaintext");

      const createdMap = await applyTree({ operation: "create", parentId: nbWrite.id, title: "树建导图", nodeType: "mindmap" });
      assert.equal(createdMap.isError, undefined, text(createdMap));
      const mapNodeId = JSON.parse(text(createdMap)).result.id;

      // 重命名、软删除、恢复思维导图节点
      assert.equal((await applyTree({ operation: "rename", nodeId: mapNodeId, title: "树建导图 v2" })).isError, undefined);
      assert.equal((await applyTree({ operation: "trash", nodeId: mapNodeId })).isError, undefined);
      assert.equal((await applyTree({ operation: "restore", nodeId: mapNodeId })).isError, undefined);
    });
  } finally {
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
