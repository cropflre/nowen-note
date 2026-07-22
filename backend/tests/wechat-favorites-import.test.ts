import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { parseWeChatDataAnalysisPayload } from "../src/services/wechatFavoritesAdapters/wechatDataAnalysisV1";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-wechat-favorites-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = path.join(tmpDir, "user-data");

let getDb: typeof import("../src/db/schema").getDb;
let closeDb: typeof import("../src/db/schema").closeDb;
let importPackage: typeof import("../src/services/wechatFavoritesPackageImport").importWeChatFavoritesPackageFromZipFile;
let normalizeSafeZipPath: typeof import("../src/services/wechatFavoritesPackageImport").normalizeSafeZipPath;

const USER_ID = "wechat-import-user";
const MEDIA_MD5 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function writeFixture(filename: string, title = "图片收藏"): Promise<string> {
  const zip = new JSZip();
  zip.file("favorites.json", JSON.stringify({
    dataset: "favorites",
    generatedAt: "2026-07-16T08:00:00+08:00",
    items: [{
      serverId: "9001",
      localId: "101",
      type: 2,
      title,
      updateTime: 1720000000,
      tags: [{ name: "微信" }],
      textBlocks: ["收藏正文"],
      attachments: [{
        dataId: "media-1",
        dataType: 2,
        renderType: "image",
        title: "照片",
        description: "图片说明",
        fullMd5: MEDIA_MD5,
        dataFormat: "png",
      }],
    }],
  }));
  zip.file(`media/${MEDIA_MD5}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  const target = path.join(tmpDir, filename);
  fs.writeFileSync(target, await zip.generateAsync({ type: "nodebuffer" }));
  return target;
}

test.before(async () => {
  const [schema, service] = await Promise.all([
    import("../src/db/schema"),
    import("../src/services/wechatFavoritesPackageImport"),
  ]);
  getDb = schema.getDb;
  closeDb = schema.closeDb;
  importPackage = service.importWeChatFavoritesPackageFromZipFile;
  normalizeSafeZipPath = service.normalizeSafeZipPath;
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  const bootstrap = await writeFixture("bootstrap.zip");
  await importPackage(bootstrap, { userId: USER_ID, workspaceId: null, dryRun: true });
});

test.beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM note_import_origins").run();
  db.prepare("DELETE FROM note_tags").run();
  db.prepare("DELETE FROM tags").run();
  db.prepare("DELETE FROM attachments").run();
  db.prepare("DELETE FROM notes").run();
  db.prepare("DELETE FROM notebooks").run();
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("adapter groups WeChatDataAnalysis favorite archive messages by favorite id", () => {
  const parsed = parseWeChatDataAnalysisPayload({
    conversations: [{
      username: "__favorites__",
      messages: [
        { id: "favorite_77_88_text_0", localId: 77, serverId: 88, type: 1, renderType: "text", content: "第一段" },
        { id: "favorite_77_88_attachment_1", localId: 77, serverId: 88, type: 2, renderType: "image", title: "图片", imageMd5: MEDIA_MD5 },
      ],
    }],
  });

  assert.ok(parsed);
  assert.equal(parsed.adapter, "wechat-data-analysis-v1");
  assert.equal(parsed.favorites.length, 1);
  assert.equal(parsed.favorites[0].externalId, "server:88");
  assert.deepEqual(parsed.favorites[0].textBlocks, ["第一段"]);
  assert.equal(parsed.favorites[0].items[0].kind, "image");
  assert.ok(parsed.favorites[0].items[0].mediaRefs.includes(MEDIA_MD5));
});

test("ZIP path normalization rejects traversal and absolute paths", () => {
  assert.equal(normalizeSafeZipPath("media/photo.jpg"), "media/photo.jpg");
  assert.equal(normalizeSafeZipPath("../secret.txt"), null);
  assert.equal(normalizeSafeZipPath("folder/../../secret.txt"), null);
  assert.equal(normalizeSafeZipPath("/etc/passwd"), null);
  assert.equal(normalizeSafeZipPath("C:/Windows/system.ini"), null);
});

test("dry-run reports types, media availability and creation plan without writing notes", async () => {
  const fixture = await writeFixture("preflight.zip");
  const report = await importPackage(fixture, {
    userId: USER_ID,
    workspaceId: null,
    dryRun: true,
    duplicateStrategy: "skip",
  });

  assert.equal(report.success, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.counts.total, 1);
  assert.equal(report.counts.wouldCreate, 1);
  assert.equal(report.stats.types.image, 1);
  assert.equal(report.stats.mediaAvailable, 1);
  assert.equal(report.stats.mediaMissing, 0);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count, 0);
});

test("formal import creates notebook, note, attachment, tag and origin mapping", async () => {
  const fixture = await writeFixture("import.zip");
  const report = await importPackage(fixture, {
    userId: USER_ID,
    workspaceId: null,
    rootNotebookName: "微信收藏测试",
    groupByYear: true,
    preserveTags: true,
    continueOnMissingMedia: true,
    duplicateStrategy: "skip",
  });

  assert.equal(report.success, true);
  assert.equal(report.counts.imported, 1);
  assert.equal(report.counts.attachments, 1);
  assert.equal(report.counts.tagsCreated, 1);

  const note = getDb().prepare("SELECT id, title, content, contentFormat FROM notes LIMIT 1").get() as any;
  assert.equal(note.title, "图片收藏");
  assert.equal(note.contentFormat, "tiptap-json");
  assert.match(note.content, /\/api\/attachments\//);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM attachments").get() as any).count, 1);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM tags WHERE name = '微信'").get() as any).count, 1);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM note_import_origins WHERE externalId = 'server:9001'").get() as any).count, 1);
  const notebookNames = (getDb().prepare("SELECT name FROM notebooks ORDER BY parentId IS NOT NULL, name").all() as Array<{ name: string }>).map((row) => row.name);
  assert.ok(notebookNames.includes("微信收藏测试"));
  assert.ok(notebookNames.includes("2024"));
});

test("rerun supports skip and update without duplicating the source mapping", async () => {
  const first = await writeFixture("first.zip", "旧标题");
  await importPackage(first, {
    userId: USER_ID,
    workspaceId: null,
    rootNotebookName: "微信收藏",
    duplicateStrategy: "skip",
  });

  const skipped = await importPackage(first, {
    userId: USER_ID,
    workspaceId: null,
    rootNotebookName: "微信收藏",
    duplicateStrategy: "skip",
  });
  assert.equal(skipped.counts.skipped, 1);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM notes").get() as any).count, 1);

  const changed = await writeFixture("changed.zip", "更新后的标题");
  const updated = await importPackage(changed, {
    userId: USER_ID,
    workspaceId: null,
    rootNotebookName: "微信收藏",
    duplicateStrategy: "update",
  });
  assert.equal(updated.counts.updated, 1);
  assert.equal((getDb().prepare("SELECT title FROM notes LIMIT 1").get() as any).title, "更新后的标题");
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM note_import_origins").get() as any).count, 1);
});
