import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-root-documents-"));
process.env.DB_PATH = path.join(tempDir, "root-documents.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("moving folders and documents into root documents retains hidden containers and permission checks", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  await import("../src/runtime/knowledge-tree.js");
  const {getDb,closeDb} = await import("../src/db/schema.js"); closeDatabase = closeDb;
  const {createKnowledgeChild,moveKnowledgeNode,ROOT_DOCUMENT_NOTEBOOK_PREFIX} = await import("../src/services/knowledgeTree.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id,username,passwordHash) VALUES ('move-owner','move-owner','hash')").run();
  db.prepare("INSERT INTO workspaces (id,name,ownerId) VALUES ('move-ws','Move workspace','move-owner')").run();
  db.prepare("INSERT INTO workspace_members (workspaceId,userId,role) VALUES ('move-ws','move-owner','owner')").run();
  db.prepare("INSERT OR IGNORE INTO users (id,username,passwordHash) VALUES ('stranger','stranger','hash')").run();
  for (const workspaceId of [null,"move-ws"]) {
    const root = createKnowledgeChild({actorUserId:"move-owner",workspaceId,parentId:null,nodeType:"markdown",title:"Target root",db});
    const folder = createKnowledgeChild({actorUserId:"move-owner",workspaceId,parentId:null,nodeType:"folder",title:"Moving folder",db});
    const child = createKnowledgeChild({actorUserId:"move-owner",workspaceId,parentId:folder.id,nodeType:"note",title:"Moving document",db});
    const readChild = () => db.prepare("SELECT version,content,contentFormat FROM notes WHERE id=?").get(child.resourceId) as {version:number;content:string;contentFormat:string};
    const beforeMove = readChild();
    const hiddenId = (db.prepare("SELECT notebookId FROM notes WHERE id=?").get(root.resourceId) as {notebookId:string}).notebookId;
    assert.throws(() => moveKnowledgeNode({actorUserId:"stranger",nodeId:folder.id,parentId:root.id,db}));
    assert.throws(() => moveKnowledgeNode({actorUserId:"stranger",nodeId:child.id,parentId:root.id,db}));
    assert.deepEqual(readChild(),beforeMove);
    assert.equal((db.prepare("SELECT isDeleted FROM notebooks WHERE id=?").get(hiddenId) as {isDeleted:number}).isDeleted,1);
    assert.equal(moveKnowledgeNode({actorUserId:"move-owner",nodeId:folder.id,parentId:root.id,db}).parentId,root.id);
    assert.equal(moveKnowledgeNode({actorUserId:"move-owner",nodeId:child.id,parentId:root.id,db}).parentId,root.id);
    assert.deepEqual(readChild(),{...beforeMove,version:beforeMove.version+1});
    moveKnowledgeNode({actorUserId:"move-owner",nodeId:child.id,parentId:root.id,sortOrder:8,db});
    assert.deepEqual(readChild(),{...beforeMove,version:beforeMove.version+1});
    assert.equal((db.prepare("SELECT isDeleted FROM notebooks WHERE id=?").get(hiddenId) as {isDeleted:number}).isDeleted,1);
    assert.equal(db.prepare("SELECT id FROM knowledge_tree_nodes WHERE id=?").get(`notebook:${hiddenId}`),undefined);
    assert.ok(hiddenId.startsWith(ROOT_DOCUMENT_NOTEBOOK_PREFIX));
  }
});

test("knowledge tree creates rich-text and Markdown documents at root", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  await import("../src/runtime/knowledge-tree.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const {
    ROOT_DOCUMENT_NOTEBOOK_PREFIX,
    createKnowledgeChild,
    listKnowledgeTree,
    moveKnowledgeNode,
  } = await import("../src/services/knowledgeTree.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("owner", "owner", "hash");
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run("ws", "Team", "owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run("ws", "owner", "owner");

  const richText = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: null,
    nodeType: "note",
    title: "根级富文本文档",
    db,
  });
  const markdown = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: null,
    nodeType: "markdown",
    title: "根级 Markdown 文档",
    db,
  });

  assert.equal(richText.parentId, null);
  assert.equal(markdown.parentId, null);

  const richTextRow = db.prepare("SELECT notebookId, contentFormat FROM notes WHERE id = ?")
    .get(richText.resourceId) as { notebookId: string; contentFormat: string };
  const markdownRow = db.prepare("SELECT notebookId, contentFormat FROM notes WHERE id = ?")
    .get(markdown.resourceId) as { notebookId: string; contentFormat: string };

  assert.match(richTextRow.notebookId, new RegExp(`^${ROOT_DOCUMENT_NOTEBOOK_PREFIX}workspace:`));
  assert.equal(richTextRow.contentFormat, "tiptap-json");
  assert.equal(markdownRow.notebookId, richTextRow.notebookId);
  assert.equal(markdownRow.contentFormat, "markdown");

  const hiddenContainer = db.prepare("SELECT isDeleted FROM notebooks WHERE id = ?")
    .get(richTextRow.notebookId) as { isDeleted: number };
  assert.equal(hiddenContainer.isDeleted, 1);

  const initialTree = listKnowledgeTree({ userId: "owner", workspaceId: "ws", db });
  assert.equal(initialTree.find((node) => node.id === richText.id)?.parentId, null);
  assert.equal(initialTree.find((node) => node.id === markdown.id)?.parentId, null);
  assert.equal(
    initialTree.some((node) => node.resourceType === "notebook" && node.resourceId.startsWith(ROOT_DOCUMENT_NOTEBOOK_PREFIX)),
    false,
  );

  const folder = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: null,
    nodeType: "folder",
    title: "普通文件夹",
    db,
  });

  moveKnowledgeNode({
    actorUserId: "owner",
    nodeId: richText.id,
    parentId: folder.id,
    db,
  });
  assert.equal(
    (db.prepare("SELECT notebookId FROM notes WHERE id = ?").get(richText.resourceId) as { notebookId: string }).notebookId,
    folder.resourceId,
  );

  const movedBack = moveKnowledgeNode({
    actorUserId: "owner",
    nodeId: richText.id,
    parentId: null,
    db,
  });
  assert.equal(movedBack.parentId, null);
  assert.match(
    (db.prepare("SELECT notebookId FROM notes WHERE id = ?").get(richText.resourceId) as { notebookId: string }).notebookId,
    new RegExp(`^${ROOT_DOCUMENT_NOTEBOOK_PREFIX}workspace:`),
  );
  assert.equal(
    listKnowledgeTree({ userId: "owner", workspaceId: "ws", db })
      .find((node) => node.id === richText.id)?.parentId,
    null,
  );
});
