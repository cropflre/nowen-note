import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import JSZip from "jszip";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-team-root-export-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_INSTANCE_ID = "team-root-export-test";

let closeDb: typeof import("../src/db/schema").closeDb;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("team root document can export Markdown + attachments from its hidden root container", async () => {
  const schema = await import("../src/db/schema");
  const service = await import("../src/services/markdownExportJobs");
  closeDb = schema.closeDb;
  const db = schema.getDb();

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("team-owner", "team-owner", "hash");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("team-member", "team-member", "hash");
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run("team-export", "团队空间", "team-owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run("team-export", "team-owner", "owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run("team-export", "team-member", "editor");

  const hiddenNotebookId = "__nowen_root_documents__:workspace:team-export";
  db.prepare(`
    INSERT INTO notebooks (
      id, userId, workspaceId, parentId, name, sortOrder, isExpanded, isDeleted
    ) VALUES (?, ?, ?, NULL, ?, ?, 0, 1)
  `).run(hiddenNotebookId, "team-owner", "team-export", "__NOWEN_ROOT_DOCUMENTS__", -2147483648);

  db.prepare(`
    INSERT INTO notes (
      id, userId, workspaceId, notebookId, title, content, contentText, contentFormat,
      sortOrder, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    "team-root-note",
    "team-owner",
    "team-export",
    hiddenNotebookId,
    "团队根文档",
    "# 团队根文档\n\n[附件](/api/attachments/team-root-attachment)",
    "团队根文档",
    "markdown",
    "2026-08-18 09:00:00",
    "2026-08-18 09:00:00",
  );

  const attachmentDir = path.join(tmpDir, "attachments");
  fs.mkdirSync(attachmentDir, { recursive: true });
  fs.writeFileSync(path.join(attachmentDir, "team-root.txt"), "team root attachment");
  db.prepare(`
    INSERT INTO attachments (id, userId, noteId, filename, mimeType, size, path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "team-root-attachment",
    "team-owner",
    "team-root-note",
    "团队附件.txt",
    "text/plain",
    20,
    "team-root.txt",
  );

  const created = service.createMarkdownExportJob({
    userId: "team-member",
    inlineImages: false,
    layout: "flat",
    filenameBase: "团队根文档",
    notes: [{
      id: "team-root-note",
      title: "团队根文档",
      notebookName: null,
      createdAt: "2026-08-18 09:00:00",
      updatedAt: "2026-08-18 09:00:00",
      contentFormat: "markdown",
      markdown: "# 团队根文档\n\n[附件](/api/attachments/team-root-attachment)",
    }],
  });

  let snapshot = created;
  for (let i = 0; i < 300 && snapshot.state !== "ready" && snapshot.state !== "error"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    snapshot = service.getMarkdownExportJob(created.id, "team-member")!;
  }

  assert.equal(snapshot.state, "ready", snapshot.message);
  assert.ok(snapshot.downloadToken);

  const app = new Hono();
  app.get("/download/:token", service.handleMarkdownExportDownload);
  const response = await app.request(`/download/${snapshot.downloadToken}`);
  assert.equal(response.status, 200);

  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  assert.ok(zip.file("团队根文档.md"));
  assert.equal(
    await zip.file("assets/att-team-root-attachment-团队附件.txt")!.async("string"),
    "team root attachment",
  );
  assert.match(
    await zip.file("团队根文档.md")!.async("string"),
    /\[附件\]\(\.\/assets\/att-team-root-attachment-团队附件\.txt\)/,
  );
  assert.equal(zip.file("__NOWEN_ROOT_DOCUMENTS__/团队根文档.md"), null);

  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  assert.equal(manifest.scope.workspaceId, "team-export");
  assert.equal(manifest.counts.notes, 1);
});
