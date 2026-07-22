import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import JSZip from "jszip";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-markdown-export-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let closeDb: typeof import("../src/db/schema").closeDb;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("export helpers reject traversal and rewrite attachment URLs", async () => {
  const { markdownExportTestUtils } = await import("../src/services/markdownExportJobs");
  assert.equal(markdownExportTestUtils.normalizeAssetRelPath("../secret.txt"), null);
  assert.equal(markdownExportTestUtils.normalizeAssetRelPath("assets\\图片.png"), "assets/图片.png");
  assert.deepEqual(
    markdownExportTestUtils.attachmentIdsInMarkdown(
      "![a](/api/attachments/att-1?download=0) [b](https://note.test/api/attachments/att-2)",
    ),
    ["att-1", "att-2"],
  );
  assert.equal(
    markdownExportTestUtils.replaceAttachmentUrl(
      "![a](https://note.test/api/attachments/att-1?download=0)",
      "att-1",
      "./assets/a.png",
    ),
    "![a](./assets/a.png)",
  );
});

test("markdown export preserves the tree, attachments and duplicate note titles", async () => {
  const schema = await import("../src/db/schema");
  const service = await import("../src/services/markdownExportJobs");
  closeDb = schema.closeDb;
  const db = schema.getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("user-export", "user-export", "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name, sortOrder) VALUES (?, ?, ?, ?)")
    .run("nb-export", "user-export", "笔记本", 10);
  db.prepare("INSERT INTO notebooks (id, userId, parentId, name, sortOrder) VALUES (?, ?, ?, ?, ?)")
    .run("nb-empty", "user-export", "nb-export", "空目录", 20);
  for (const id of ["note-1", "note-2"]) {
    db.prepare("INSERT INTO notes (id, userId, notebookId, title) VALUES (?, ?, ?, ?)")
      .run(id, "user-export", "nb-export", "同名笔记");
  }
  const attachmentsDir = path.join(tmpDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(attachmentsDir, "asset.bin"), Buffer.from("streamed attachment"));
  db.prepare(
    `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("att-1", "note-1", "user-export", "附件.bin", "application/octet-stream", 19, "asset.bin");

  const created = service.createMarkdownExportJob({
    userId: "user-export",
    inlineImages: false,
    notes: [
      {
        id: "note-1",
        title: "同名笔记",
        notebookName: "笔记本",
        createdAt: "2026-07-11 10:00:00",
        updatedAt: "2026-07-11 10:00:00",
        contentFormat: "markdown",
        markdown: "[附件](/api/attachments/att-1?download=0)",
      },
      {
        id: "note-2",
        title: "同名笔记",
        notebookName: "笔记本",
        createdAt: "2026-07-11 10:00:00",
        updatedAt: "2026-07-11 10:00:00",
        contentFormat: "markdown",
        markdown: "第二篇",
      },
    ],
  });

  let snapshot = created;
  for (let i = 0; i < 300 && snapshot.state !== "ready" && snapshot.state !== "error"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    snapshot = service.getMarkdownExportJob(created.id, "user-export")!;
  }
  assert.equal(snapshot.state, "ready", snapshot.message);
  assert.ok(snapshot.downloadToken);

  const app = new Hono();
  app.get("/download/:token", service.handleMarkdownExportDownload);
  const response = await app.request(`/download/${snapshot.downloadToken}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.ok(Number(response.headers.get("content-length")) > 0);

  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  assert.ok(zip.file("笔记本/同名笔记.md"));
  assert.ok(zip.file("笔记本/同名笔记 (2).md"));
  assert.ok(zip.folder("笔记本/空目录"));
  assert.equal(
    await zip.file("笔记本/assets/att-att-1-附件.bin")!.async("string"),
    "streamed attachment",
  );
  assert.match(
    await zip.file("笔记本/同名笔记.md")!.async("string"),
    /\[附件\]\(\.\/assets\/att-att-1-附件\.bin\)/,
  );
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  assert.equal(manifest.format, "nowen-package");
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.packageKind, "markdown");
  const tree = JSON.parse(await zip.file("tree.json")!.async("string"));
  assert.equal(tree.nodes.length, 2);
  const attachments = JSON.parse(await zip.file("attachments.json")!.async("string"));
  assert.equal(attachments.items.length, 1);
});

test("single-note flat export keeps the note and assets at ZIP root", async () => {
  const service = await import("../src/services/markdownExportJobs");
  const created = service.createMarkdownExportJob({
    userId: "user-export",
    inlineImages: false,
    layout: "flat",
    filenameBase: "资料分析模块",
    notes: [{
      id: "note-1",
      title: "资料分析模块",
      notebookName: null,
      createdAt: "2026-07-11 10:00:00",
      updatedAt: "2026-07-11 10:00:00",
      contentFormat: "markdown",
      markdown: "![图](./assets/image.png)",
      inlineAssets: [{ relPath: "assets/image.png", base64: Buffer.from("image").toString("base64") }],
    }],
  });

  let snapshot = created;
  for (let i = 0; i < 300 && snapshot.state !== "ready" && snapshot.state !== "error"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    snapshot = service.getMarkdownExportJob(created.id, "user-export")!;
  }
  assert.equal(snapshot.state, "ready", snapshot.message);
  assert.equal(snapshot.filename, "资料分析模块.zip");

  const app = new Hono();
  app.get("/download/:token", service.handleMarkdownExportDownload);
  const response = await app.request(`/download/${snapshot.downloadToken}`);
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  assert.ok(zip.file("资料分析模块.md"));
  assert.equal(await zip.file("assets/image.png")!.async("string"), "image");
  assert.equal(zip.file("未分类/资料分析模块.md"), null);
});

test("generated PDF can be staged and downloaded from a real HTTP response", async () => {
  const service = await import("../src/services/markdownExportJobs");
  const source = new TextEncoder().encode("pdf-content");
  const body = new Response(source).body;
  assert.ok(body);
  const staged = await service.stageGeneratedExport({
    userId: "user-export",
    filename: "资料分析模块.pdf",
    contentType: "application/pdf",
    body,
    contentLength: source.byteLength,
  });

  const app = new Hono();
  app.get("/download/:token", service.handleMarkdownExportDownload);
  const response = await app.request(`/download/${staged.downloadToken}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.match(response.headers.get("content-disposition") || "", /\.pdf/i);
  assert.equal(await response.text(), "pdf-content");
});

test("markdown export route validates note ownership and exposes asynchronous status", async () => {
  const exportRouter = (await import("../src/routes/export")).default;
  const app = new Hono();
  app.route("/export", exportRouter);
  const stagedPdf = await app.request("/export/download-jobs", {
    method: "POST",
    headers: {
      "X-User-Id": "user-export",
      "X-Export-Filename": encodeURIComponent("资料分析模块.pdf"),
      "Content-Type": "application/pdf",
    },
    body: "pdf-route-content",
  });
  assert.equal(stagedPdf.status, 201, await stagedPdf.clone().text());
  const stagedBody = await stagedPdf.json() as { filename: string; downloadToken: string };
  assert.equal(stagedBody.filename, "资料分析模块.pdf");
  assert.ok(stagedBody.downloadToken);

  const payload = {
    notes: [{
      id: "note-1",
      title: "路由导出",
      notebookName: "笔记本",
      createdAt: "2026-07-11 10:00:00",
      updatedAt: "2026-07-11 10:00:00",
      contentFormat: "markdown",
      markdown: "正文",
    }],
  };

  const forbidden = await app.request("/export/markdown-package/jobs", {
    method: "POST",
    headers: { "X-User-Id": "another-user", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(forbidden.status, 403);

  const created = await app.request("/export/markdown-package/jobs", {
    method: "POST",
    headers: { "X-User-Id": "user-export", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (created.status !== 202) assert.equal(created.status, 202, await created.text());
  const createdBody = await created.json() as { job: { id: string } };

  let state = "queued";
  for (let i = 0; i < 300 && state !== "ready" && state !== "error"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await app.request(`/export/markdown-package/jobs/${createdBody.job.id}`, {
      headers: { "X-User-Id": "user-export" },
    });
    assert.equal(status.status, 200);
    state = ((await status.json()) as { job: { state: string } }).job.state;
  }
  assert.equal(state, "ready");
});
