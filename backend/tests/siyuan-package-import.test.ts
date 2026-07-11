import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import JSZip from "jszip";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-siyuan-import-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const USER_ID = "siyuan-import-user";
const WORKSPACE_ID = "siyuan-import-workspace";
const TARGET_NOTEBOOK_ID = "siyuan-target-notebook";

let closeDb: () => void;
let getDb: () => import("better-sqlite3").Database;
let importSiyuanPackageFromZipFile: typeof import("../src/services/siyuanPackageImport").importSiyuanPackageFromZipFile;
let app: Hono;

function syDoc(id: string, title: string, children: any[] = []) {
  return {
    ID: id,
    Type: "NodeDocument",
    Properties: { title },
    updated: "20260102030405",
    Children: children,
  };
}

function paragraph(children: any[]) {
  return { Type: "NodeParagraph", Children: children };
}

function text(value: string) {
  return { Type: "NodeText", Data: value };
}

function textMark(type: string, value: string) {
  return {
    Type: "NodeTextMark",
    TextMarkType: type,
    TextMarkTextContent: value,
  };
}

function image(src: string, alt = "图片") {
  return {
    Type: "NodeImage",
    Children: [
      { Type: "NodeLinkText", Data: alt },
      { Type: "NodeLinkDest", Data: src },
    ],
  };
}

function attachment(src: string) {
  return { Type: "NodeVideo", Data: `<video src="${src}"></video>` };
}

function unsupported() {
  return { Type: "NodeAttributeView" };
}

async function writeZip(name: string, files: Record<string, string | Uint8Array>) {
  const zip = new JSZip();
  for (const [filePath, content] of Object.entries(files)) {
    zip.file(filePath, content);
  }
  const zipPath = path.join(tmpDir, name);
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
  return zipPath;
}

async function writeFixtureZip(name: string) {
  return writeZip(name, {
    "data/box/.siyuan/conf.json": JSON.stringify({ name: "思源库" }),
    "data/box/parent.sy": JSON.stringify(syDoc("parent", "父级目录")),
    "data/box/parent/child.sy": JSON.stringify(syDoc("child", "子级目录")),
    "data/box/parent/child/doc.sy": JSON.stringify(syDoc("doc", "导入正文", [
      paragraph([text("正文 "), image("assets/pic.png"), text(" "), attachment("assets/demo.mp4")]),
      paragraph([image("assets/missing.png", "缺失图")]),
      unsupported(),
    ])),
    "data/box/parent/child/assets/pic.png": new Uint8Array([1, 2, 3]),
    "data/box/parent/child/assets/demo.mp4": new Uint8Array([4, 5, 6, 7]),
    "data/box/parent/child/assets/unreferenced.pdf": new Uint8Array([8, 9]),
  });
}

function db() {
  return getDb();
}

function seedBaseData() {
  db()
    .prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  db()
    .prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run(WORKSPACE_ID, "思源测试工作区", USER_ID);
  db()
    .prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run(WORKSPACE_ID, USER_ID, "editor");
  db()
    .prepare("INSERT INTO notebooks (id, userId, parentId, name, icon, workspaceId) VALUES (?, ?, NULL, ?, ?, ?)")
    .run(TARGET_NOTEBOOK_ID, USER_ID, "指定导入", "📥", WORKSPACE_ID);
}

function listNotebooks() {
  return db()
    .prepare("SELECT id, parentId, name, workspaceId FROM notebooks ORDER BY name")
    .all() as Array<{ id: string; parentId: string | null; name: string; workspaceId: string | null }>;
}

function getNoteByTitle(title: string, notebookId?: string) {
  const sql = notebookId
    ? "SELECT id, title, notebookId, content, contentText, contentFormat, workspaceId, createdAt, updatedAt FROM notes WHERE title = ? AND notebookId = ?"
    : "SELECT id, title, notebookId, content, contentText, contentFormat, workspaceId, createdAt, updatedAt FROM notes WHERE title = ?";
  return db()
    .prepare(sql)
    .get(...(notebookId ? [title, notebookId] : [title])) as
    | {
      id: string;
      title: string;
      notebookId: string;
      content: string;
      contentText: string;
      contentFormat: string;
      workspaceId: string | null;
      createdAt: string;
      updatedAt: string;
    }
    | undefined;
}

function listAttachments(noteId: string) {
  return db()
    .prepare("SELECT id, noteId, filename, mimeType, size, path, workspaceId, uploadSource FROM attachments WHERE noteId = ? ORDER BY filename")
    .all(noteId) as Array<{
      id: string;
      noteId: string;
      filename: string;
      mimeType: string;
      size: number;
      path: string;
      workspaceId: string | null;
      uploadSource: string;
    }>;
}

test.before(async () => {
  const [serviceModule, schemaModule, exportModule] = await Promise.all([
    import("../src/services/siyuanPackageImport"),
    import("../src/db/schema"),
    import("../src/routes/export"),
  ]);
  importSiyuanPackageFromZipFile = serviceModule.importSiyuanPackageFromZipFile;
  closeDb = schemaModule.closeDb;
  getDb = schemaModule.getDb;
  app = new Hono();
  app.route("/export", exportModule.default);
  seedBaseData();
});

test.after(async () => {
  closeDb();
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (err?.code !== "EBUSY") throw err;
      if (i === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("service import preserves hierarchy, rewrites referenced assets, and reports warnings", async () => {
  const zipPath = await writeFixtureZip("service-import.zip");

  const result = await importSiyuanPackageFromZipFile(zipPath, {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    contentFormat: "markdown",
  });

  assert.equal(result.success, true);
  assert.equal(result.count, 3);
  assert.equal(result.workspaceId, WORKSPACE_ID);
  assert.equal(result.stats.syFiles, 3);
  assert.equal(result.stats.assets, 3);
  assert.equal(result.stats.importedAssets, 2);
  assert.equal(result.stats.unresolvedAssets, 1);
  assert.equal(result.stats.unsupportedNodes.NodeAttributeView, 1);
  assert.ok(result.warnings.some((item) => item.includes("Siyuan asset not found: assets/missing.png")));
  assert.ok(result.warnings.some((item) => item.includes("attribute view")));

  const notebooks = listNotebooks();
  const root = notebooks.find((item) => item.name === "思源库");
  const parent = notebooks.find((item) => item.name === "父级目录");
  const child = notebooks.find((item) => item.name === "子级目录");
  assert.ok(root);
  assert.ok(parent);
  assert.ok(child);
  assert.equal(root.workspaceId, WORKSPACE_ID);
  assert.equal(parent.parentId, root.id);
  assert.equal(child.parentId, parent.id);

  const note = getNoteByTitle("导入正文");
  assert.ok(note);
  assert.equal(note.notebookId, child.id);
  assert.equal(note.workspaceId, WORKSPACE_ID);
  assert.equal(note.contentFormat, "markdown");
  assert.match(note.content, /\/api\/attachments\//);
  assert.doesNotMatch(note.content, /assets\/pic\.png/);
  assert.doesNotMatch(note.content, /assets\/demo\.mp4/);
  assert.match(note.content, /assets\/missing\.png/);
  assert.match(note.contentText, /正文/);
  assert.match(note.createdAt, /^2026-01-02T03:04:05/);

  const attachments = listAttachments(note.id);
  assert.deepEqual(attachments.map((item) => item.filename).sort(), ["demo.mp4", "pic.png"]);
  assert.deepEqual(attachments.map((item) => item.workspaceId), [WORKSPACE_ID, WORKSPACE_ID]);
  assert.deepEqual(attachments.map((item) => item.uploadSource), ["siyuan_import", "siyuan_import"]);
  assert.equal(attachments.find((item) => item.filename === "pic.png")?.mimeType, "image/png");
  assert.equal(attachments.find((item) => item.filename === "demo.mp4")?.mimeType, "video/mp4");

  const referenceCount = db()
    .prepare("SELECT COUNT(*) AS count FROM attachment_references WHERE noteId = ?")
    .get(note.id) as { count: number };
  assert.equal(referenceCount.count, 2);
});

test("route import matches service behavior for target notebook and workspace writes", async () => {
  const zipPath = await writeFixtureZip("route-import.zip");
  const form = new FormData();
  form.set("file", new File([fs.readFileSync(zipPath)], "route-import.zip", { type: "application/zip" }));

  const res = await app.request(
    `/export/import/siyuan-package?workspaceId=${WORKSPACE_ID}&targetNotebookId=${TARGET_NOTEBOOK_ID}&contentFormat=markdown`,
    {
      method: "POST",
      headers: { "X-User-Id": USER_ID },
      body: form,
    },
  );

  const textBody = await res.text();
  assert.equal(res.status, 201, textBody);
  const result = JSON.parse(textBody) as {
    success: boolean;
    count: number;
    notebookId: string;
    notebookIds: string[];
    workspaceId: string | null;
    stats: { importedAssets: number; unresolvedAssets: number; unsupportedNodes: Record<string, number> };
  };
  assert.equal(result.success, true);
  assert.equal(result.count, 3);
  assert.equal(result.workspaceId, WORKSPACE_ID);
  assert.equal(result.notebookId, TARGET_NOTEBOOK_ID);
  assert.deepEqual(result.notebookIds, [TARGET_NOTEBOOK_ID]);
  assert.equal(result.stats.importedAssets, 2);
  assert.equal(result.stats.unresolvedAssets, 1);
  assert.equal(result.stats.unsupportedNodes.NodeAttributeView, 1);

  const routeNotes = db()
    .prepare("SELECT id, title, notebookId, contentFormat, workspaceId FROM notes WHERE notebookId = ? ORDER BY title")
    .all(TARGET_NOTEBOOK_ID) as Array<{ id: string; title: string; notebookId: string; contentFormat: string; workspaceId: string | null }>;
  assert.deepEqual(routeNotes.map((note) => note.title), ["子级目录", "导入正文", "父级目录"]);
  assert.deepEqual(routeNotes.map((note) => note.contentFormat), ["markdown", "markdown", "markdown"]);
  assert.deepEqual(routeNotes.map((note) => note.workspaceId), [WORKSPACE_ID, WORKSPACE_ID, WORKSPACE_ID]);

  const routeDoc = getNoteByTitle("导入正文", TARGET_NOTEBOOK_ID);
  assert.ok(routeDoc);
  const routeAttachments = listAttachments(routeDoc.id);
  assert.equal(routeAttachments.length, 2);
  assert.ok(routeAttachments.every((item) => routeDoc.content.includes(`/api/attachments/${item.id}`)));
});

test("service import stores Tiptap JSON when contentFormat is tiptap-json", async () => {
  const zipPath = await writeZip("tiptap-json-import.zip", {
    "doc.sy": JSON.stringify(syDoc("tiptap-doc", "Tiptap Import", [
      paragraph([text("Rich text "), image("assets/pic.png"), text(" "), attachment("assets/demo.mp4")]),
    ])),
    "assets/pic.png": new Uint8Array([1, 2, 3]),
    "assets/demo.mp4": new Uint8Array([4, 5, 6, 7]),
  });

  const result = await importSiyuanPackageFromZipFile(zipPath, {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    targetNotebookId: TARGET_NOTEBOOK_ID,
    contentFormat: "tiptap-json",
  });

  assert.equal(result.success, true);
  assert.equal(result.count, 1);

  const note = getNoteByTitle("Tiptap Import", TARGET_NOTEBOOK_ID);
  assert.ok(note);
  assert.equal(note.contentFormat, "tiptap-json");
  assert.doesNotMatch(note.content, /^Rich text/);
  assert.doesNotMatch(note.content, /!\[图片]\(/);
  assert.doesNotMatch(note.content, /@\[video]\(/);

  const parsed = JSON.parse(note.content) as {
    type: string;
    content: Array<{ type: string; attrs?: Record<string, unknown>; content?: Array<{ type: string; text?: string }> }>;
  };
  assert.equal(parsed.type, "doc");
  assert.ok(Array.isArray(parsed.content));
  assert.equal(parsed.content[0].type, "paragraph");
  assert.equal(parsed.content[0].content?.[0].text, "Rich text");
  assert.equal(parsed.content[1].type, "image");
  assert.match(String(parsed.content[1].attrs?.src), /^\/api\/attachments\//);
  assert.equal(parsed.content[2].type, "video");
  assert.match(String(parsed.content[2].attrs?.src), /^\/api\/attachments\//);

  const attachments = listAttachments(note.id);
  assert.equal(attachments.length, 2);
  const referenceCount = db()
    .prepare("SELECT COUNT(*) AS count FROM attachment_references WHERE noteId = ?")
    .get(note.id) as { count: number };
  assert.equal(referenceCount.count, 2);
});

test("service import syncs Siyuan tags into tags and note_tags", async () => {
  db()
    .prepare("INSERT INTO tags (id, userId, name, color, workspaceId) VALUES (?, ?, ?, ?, ?)")
    .run("existing-tag", USER_ID, "共同", "#58a6ff", WORKSPACE_ID);

  const zipPath = await writeZip("tag-sync-import.zip", {
    "tag-doc-1.sy": JSON.stringify(syDoc("tag-doc-1", "标签文档一", [
      paragraph([text("标签 "), textMark("tag", "共同"), text(" 与 "), textMark("tag", "新增")]),
    ])),
    "tag-doc-2.sy": JSON.stringify(syDoc("tag-doc-2", "标签文档二", [
      paragraph([text("另一个标签 "), textMark("tag", "#新增#")]),
    ])),
  });

  const result = await importSiyuanPackageFromZipFile(zipPath, {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    targetNotebookId: TARGET_NOTEBOOK_ID,
    contentFormat: "markdown",
  });

  assert.equal(result.success, true);
  assert.equal(result.count, 2);

  const tags = db()
    .prepare("SELECT id, name, workspaceId FROM tags WHERE userId = ? AND name IN (?, ?) ORDER BY name")
    .all(USER_ID, "共同", "新增") as Array<{ id: string; name: string; workspaceId: string | null }>;
  assert.deepEqual(tags.map((item) => item.name), ["共同", "新增"]);
  assert.equal(tags.find((item) => item.name === "共同")?.id, "existing-tag");
  assert.ok(tags.find((item) => item.name === "新增")?.id);
  assert.ok(tags.every((item) => item.workspaceId === WORKSPACE_ID));

  const links = db()
    .prepare(`
      SELECT n.title AS title, t.name AS tagName
      FROM note_tags nt
      JOIN notes n ON n.id = nt.noteId
      JOIN tags t ON t.id = nt.tagId
      WHERE n.title IN (?, ?)
      ORDER BY n.title, t.name
    `)
    .all("标签文档一", "标签文档二") as Array<{ title: string; tagName: string }>;
  assert.deepEqual(links, [
    { title: "标签文档一", tagName: "共同" },
    { title: "标签文档一", tagName: "新增" },
    { title: "标签文档二", tagName: "新增" },
  ]);
});

test("service import removes newly written files when database insert fails", async () => {
  const zipPath = await writeZip("cleanup-on-failure.zip", {
    "doc.sy": JSON.stringify(syDoc("doc", "清理测试", [
      paragraph([image("assets/pic.png")]),
    ])),
    "assets/pic.png": new Uint8Array([9, 8, 7]),
  });
  const attachmentsDir = path.join(tmpDir, "attachments");
  const listStoredFiles = () => fs.existsSync(attachmentsDir)
    ? fs.readdirSync(attachmentsDir, { recursive: true })
      .filter((item) => {
        const abs = path.join(attachmentsDir, String(item));
        return fs.statSync(abs).isFile();
      })
      .map(String)
      .sort()
    : [];
  const beforeFiles = listStoredFiles();

  db().prepare("DROP TABLE notes").run();

  await assert.rejects(
    () => importSiyuanPackageFromZipFile(zipPath, { userId: USER_ID, workspaceId: WORKSPACE_ID }),
    /no such table: notes/i,
  );

  assert.deepEqual(listStoredFiles(), beforeFiles);
});
