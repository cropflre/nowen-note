import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-attachment-cache-contract-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.ATTACHMENT_LEGACY_PUBLIC_URL = "false";
process.env.ATTACHMENT_SIGNING_SECRET = "test-attachment-cache-contract-secret";

const OWNER_ID = "cache-owner";
const NOTEBOOK_ID = "cache-notebook";
const NOTE_ID = "cache-note";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
  "base64",
);

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let attachmentsDir = "";
let attachmentId = "";
let attachmentPath = "";
let signedUrl = "";
let deleteThumbnailsFor: (attachmentsDir: string, id: string) => void;
let isThumbnailable: (mime: string | null | undefined) => boolean;
let computeAttachmentEtag: (attachmentId: string, variant: "original" | number) => string;
let requestMatchesEtag: (headers: Headers, etag: string) => boolean;
let handleCoreAttachmentDownload: typeof import("../src/routes/attachments-core").handleDownloadAttachment;

function db() {
  return getDb();
}

function signedRoute(url: string, extraQuery: Record<string, string> = {}): string {
  const parsed = new URL(url, "http://localhost");
  for (const [key, value] of Object.entries(extraQuery)) parsed.searchParams.set(key, value);
  return `${parsed.pathname.replace(/^\/api/, "")}${parsed.search}`;
}

async function responseJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

test.before(async () => {
  const [attachmentsModule, attachmentsCoreModule, schemaModule, thumbnailsModule, etagModule] = await Promise.all([
    import("../src/routes/attachments"),
    import("../src/routes/attachments-core"),
    import("../src/db/schema"),
    import("../src/services/thumbnails"),
    import("../src/lib/attachment-etag"),
  ]);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  attachmentsDir = attachmentsModule.getAttachmentsDir();
  deleteThumbnailsFor = thumbnailsModule.deleteThumbnailsFor;
  isThumbnailable = thumbnailsModule.isThumbnailable;
  computeAttachmentEtag = etagModule.computeAttachmentEtag;
  requestMatchesEtag = etagModule.requestMatchesEtag;
  handleCoreAttachmentDownload = attachmentsCoreModule.handleDownloadAttachment;

  app = new Hono();
  app.get("/attachments/:id", attachmentsModule.handleDownloadAttachment);
  app.route("/attachments", attachmentsModule.default);

  const database = db();
  database
    .prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(OWNER_ID, OWNER_ID, "hash");
  database
    .prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(NOTEBOOK_ID, OWNER_ID, "Cache contract");
  database
    .prepare(
      `INSERT INTO notes (id, userId, notebookId, title, content, contentText)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(NOTE_ID, OWNER_ID, NOTEBOOK_ID, "Cache contract", "{}", "Cache contract");

  const form = new FormData();
  form.set("noteId", NOTE_ID);
  form.set("file", new File([new Uint8Array(PNG_BYTES)], "cache-contract.png", { type: "image/png" }));
  const upload = await app.request("/attachments", {
    method: "POST",
    headers: { "X-User-Id": OWNER_ID },
    body: form,
  });
  assert.equal(upload.status, 201);
  const payload = await responseJson<{
    id: string;
    accessUrls?: Record<string, string>;
  }>(upload);
  attachmentId = payload.id;
  signedUrl = payload.accessUrls?.[attachmentId] || "";
  assert.ok(attachmentId);
  assert.ok(signedUrl);

  const row = database
    .prepare("SELECT path FROM attachments WHERE id = ?")
    .get(attachmentId) as { path: string } | undefined;
  assert.ok(row?.path);
  attachmentPath = path.join(attachmentsDir, row.path);
  assert.equal(fs.existsSync(attachmentPath), true);
});

test.after(() => {
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
  }
});

test("ETag is representation-aware and accepts weak or multi-value validators", () => {
  const original = computeAttachmentEtag(attachmentId, "original");
  const thumb240 = computeAttachmentEtag(attachmentId, 240);
  const thumb480 = computeAttachmentEtag(attachmentId, 480);

  assert.notEqual(original, thumb240);
  assert.notEqual(thumb240, thumb480);
  assert.match(original, /-original"$/);
  assert.match(thumb240, /-thumb-240"$/);
  assert.equal(requestMatchesEtag(new Headers({ "If-None-Match": `W/${thumb240}` }), thumb240), true);
  assert.equal(
    requestMatchesEtag(new Headers({ "If-None-Match": `"unrelated", ${thumb480}` }), thumb480),
    true,
  );
  assert.equal(requestMatchesEtag(new Headers({ "If-None-Match": thumb240 }), original), false);
});

test("authorized 304 short-circuits before reading a missing original object", async () => {
  const first = await app.request(signedRoute(signedUrl));
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  assert.match(etag, /-original"$/);

  const backupPath = `${attachmentPath}.cache-contract-backup`;
  fs.renameSync(attachmentPath, backupPath);
  try {
    const revalidated = await app.request(signedRoute(signedUrl), {
      headers: { "If-None-Match": etag },
    });
    assert.equal(revalidated.status, 304);
    assert.equal(await revalidated.text(), "");
    assert.equal(
      revalidated.headers.get("cache-control"),
      "private, no-cache, must-revalidate, no-transform",
    );

    const withoutValidator = await app.request(signedRoute(signedUrl));
    assert.equal(
      withoutValidator.status,
      404,
      "同一文件在没有验证器时应证明物理对象确实不可读",
    );
  } finally {
    fs.renameSync(backupPath, attachmentPath);
  }
});

test("thumbnail 304 short-circuits before source read and Sharp generation", async (t) => {
  if (!isThumbnailable("image/png")) {
    t.skip("当前平台未加载 sharp，缩略图链路已按设计降级");
    return;
  }

  const route = signedRoute(signedUrl, { w: "240" });
  const first = await app.request(route);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-thumbnail-width"), "240");
  const etag = first.headers.get("etag");
  assert.ok(etag);
  assert.match(etag, /-thumb-240"$/);

  deleteThumbnailsFor(attachmentsDir, attachmentId);
  const backupPath = `${attachmentPath}.thumbnail-cache-contract-backup`;
  fs.renameSync(attachmentPath, backupPath);
  try {
    const revalidated = await app.request(route, {
      headers: { "If-None-Match": etag },
    });
    assert.equal(revalidated.status, 304);
    assert.equal(await revalidated.text(), "");
  } finally {
    fs.renameSync(backupPath, attachmentPath);
  }
});


test("remote thumbnail failure reuses the already-read source buffer", async (t) => {
  if (!isThumbnailable("image/png")) {
    t.skip("当前平台未启用图片缩略图 MIME 路径");
    return;
  }

  const backupPath = `${attachmentPath}.remote-thumbnail-fallback-backup`;
  fs.renameSync(attachmentPath, backupPath);
  let objectReads = 0;
  let thumbnailAttempts = 0;
  const coreApp = new Hono();
  coreApp.get("/attachments/:id", (c) => handleCoreAttachmentDownload(c, {
    readAttachmentObject: async (storagePath) => {
      objectReads += 1;
      assert.ok(storagePath);
      return PNG_BYTES;
    },
    getOrCreateThumbnailFromBufferAsync: async (
      _attachmentsDir,
      id,
      source,
      mimeType,
      width,
    ) => {
      thumbnailAttempts += 1;
      assert.equal(id, attachmentId);
      assert.equal(mimeType, "image/png");
      assert.equal(width, 240);
      assert.deepEqual(source, PNG_BYTES);
      return null;
    },
  }));

  try {
    const response = await coreApp.request(signedRoute(signedUrl, { w: "240" }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-thumbnail-width"), null);
    assert.match(response.headers.get("etag") || "", /-original"$/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG_BYTES);
    assert.equal(thumbnailAttempts, 1);
    assert.equal(objectReads, 1, "缩略图失败回退原图不得再次读取远程对象");
  } finally {
    fs.renameSync(backupPath, attachmentPath);
  }
});
