import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import sharp from "sharp";
import { sniffHeifMime, resolveHeifUploadMime } from "../src/lib/heif-mime";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-heif-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NODE_ENV = "test";
process.env.ATTACHMENT_LEGACY_PUBLIC_URL = "false";
process.env.ATTACHMENT_SIGNING_SECRET = "heif-test-secret";
const source = fs.readFileSync(path.join(__dirname, "fixtures/heif/example.heic"));
const owner = "heif-owner";
const noteId = "heif-note";
let app: Hono;
let coreDownload: typeof import("../src/routes/attachments-core").handleDownloadAttachment;
let schema: typeof import("../src/db/schema");
let attachmentsDir: string;

test.before(async () => {
  const attachments = await import("../src/routes/attachments");
  coreDownload = (await import("../src/routes/attachments-core")).handleDownloadAttachment;
  schema = await import("../src/db/schema");
  const files = await import("../src/routes/files");
  attachmentsDir = attachments.getAttachmentsDir();
  const db = schema.getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(owner, owner, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run("heif-book", owner, "HEIF");
  db.prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, ?, ?, ?)")
    .run(noteId, owner, "heif-book", "HEIF", "{}");
  app = new Hono();
  app.get("/api/attachments/:id", attachments.handleDownloadAttachment);
  app.route("/api/attachments", attachments.default);
  app.route("/api/files", files.default);
});

test.after(() => {
  schema?.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function brandBox(major: string, compatible: string[] = []) {
  const buffer = Buffer.alloc(16 + compatible.length * 4);
  buffer.writeUInt32BE(buffer.length, 0);
  buffer.write("ftyp", 4);
  buffer.write(major, 8);
  compatible.forEach((brand, index) => buffer.write(brand, 16 + index * 4));
  return buffer;
}

async function upload(type = "", route = "/api/attachments", bytes = source, name = "华为照片.HEIC") {
  const form = new FormData();
  form.set("noteId", noteId);
  form.set("file", new File([new Uint8Array(bytes)], name, { type }));
  const response = await app.request(route, { method: "POST", headers: { "X-User-Id": owner }, body: form });
  assert.ok(response.status === 201 || response.status === 200, await response.clone().text());
  return response.json() as Promise<{
    id: string; category: string; mimeType: string; accessUrls: Record<string, string>;
  }>;
}

function withQuery(url: string, query: Record<string, string>) {
  const parsed = new URL(url, "http://localhost");
  for (const [key, value] of Object.entries(query)) parsed.searchParams.set(key, value);
  return parsed.pathname + parsed.search;
}

test("HEIF 品牌识别覆盖空 MIME、序列与兼容品牌，并排除 AVIF 和伪装扩展名", () => {
  assert.equal(sniffHeifMime(source), "image/heic");
  for (const brand of ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]) {
    assert.equal(sniffHeifMime(brandBox(brand)), "image/heic");
  }
  assert.equal(sniffHeifMime(brandBox("mif1", ["heic"])), "image/heic");
  assert.equal(sniffHeifMime(brandBox("mif1")), "image/heif");
  assert.equal(sniffHeifMime(brandBox("mif1", ["avif"])), null);
  assert.equal(sniffHeifMime(brandBox("avis", ["mif1"])), null);
  assert.equal(sniffHeifMime(Buffer.from("fake.HEIC")), null);
  assert.equal(sniffHeifMime(source.subarray(0, 12)), null);
  assert.equal(resolveHeifUploadMime(source, "image/jpeg"), "image/heic");
  assert.equal(resolveHeifUploadMime(Buffer.from("fake.HEIC"), ""), "application/octet-stream");
});

test("空 MIME 上传后作为图片插入，显示 WebP、下载原件，三种表示的 ETag 不混用", async () => {
  const payload = await upload();
  assert.equal(payload.category, "image");
  assert.equal(payload.mimeType, "image/heic");
  const url = payload.accessUrls[payload.id];
  const preview = await app.request(url);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/webp");
  assert.equal(preview.headers.get("content-disposition"), null);
  const previewBytes = Buffer.from(await preview.arrayBuffer());
  const metadata = await sharp(previewBytes).metadata();
  assert.equal(metadata.width, 1280);
  assert.equal(metadata.height, 854);
  const etag = preview.headers.get("etag")!;
  assert.match(etag, /heif-preview-v1/);
  assert.equal((await app.request(url, { headers: { "If-None-Match": etag } })).status, 304);

  const thumbnail = await app.request(withQuery(url, { w: "240" }));
  assert.equal(thumbnail.headers.get("x-thumbnail-width"), "240");
  assert.equal((await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata()).width, 240);
  assert.notEqual(thumbnail.headers.get("etag"), etag);

  for (const download of ["1", "true", "yes"]) {
    const original = await app.request(withQuery(url, { download, w: "240" }), {
      headers: { "If-None-Match": etag },
    });
    assert.equal(original.status, 200);
    assert.equal(original.headers.get("content-type"), "image/heic");
    assert.match(original.headers.get("content-disposition")!, /^attachment;/);
    assert.notEqual(original.headers.get("etag"), etag);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), source);
  }
  const row = schema.getDb().prepare("SELECT path FROM attachments WHERE id = ?").get(payload.id) as { path: string };
  assert.deepEqual(fs.readFileSync(path.join(attachmentsDir, row.path)), source);
});

test("已存在的空 MIME HEIC 无需重新上传即可生成预览，远程对象只读一次且缓存可复用", async () => {
  const payload = await upload("image/heif");
  const db = schema.getDb();
  db.prepare("UPDATE attachments SET mimeType = 'application/octet-stream' WHERE id = ?").run(payload.id);
  let reads = 0;
  const remote = new Hono();
  remote.get("/api/attachments/:id", (c) => coreDownload(c, {
    readAttachmentObject: async () => { reads++; return source; },
  }));
  const response = await remote.request(payload.accessUrls[payload.id]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(reads, 1);
  const next = await remote.request(payload.accessUrls[payload.id]);
  assert.equal(next.status, 200);
  assert.equal(reads, 1, "命中兼容副本缓存时不再读取远程原件");
  const revalidated = await remote.request(payload.accessUrls[payload.id], {
    headers: { "If-None-Match": response.headers.get("etag")! },
  });
  assert.equal(revalidated.status, 304);
  assert.equal(reads, 1);
});

test("文件管理空 MIME 上传和存量去重均归为图片，并提供兼容缩略图", async () => {
  const payload = await upload("", "/api/files/upload");
  assert.equal(payload.category, "image");
  assert.equal(payload.mimeType, "image/heic");
  schema.getDb().prepare("UPDATE attachments SET mimeType = 'application/octet-stream' WHERE id = ?").run(payload.id);
  const dedup = await upload("", "/api/files/upload");
  assert.equal(dedup.category, "image");
  assert.equal(dedup.mimeType, "image/heic");
  const detail = await app.request(`/api/files/${dedup.id}`, { headers: { "X-User-Id": owner } });
  assert.equal(detail.status, 200);
  const file = await detail.json() as { thumbnailUrl: string; category: string };
  assert.equal(file.category, "image");
  assert.equal(file.thumbnailUrl, `/api/attachments/${dedup.id}?w=240`);
});

test("分享页获得兼容预览，禁止下载与签名鉴权仍在转码前执行", async () => {
  const payload = await upload();
  const share = await app.request("/api/attachments/file-share", {
    method: "POST", headers: { "X-User-Id": owner, "Content-Type": "application/json" },
    body: JSON.stringify({ attachmentId: payload.id, allowDownload: false }),
  });
  assert.equal(share.status, 200);
  const { url } = await share.json() as { url: string };
  const preview = await app.request(url);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/webp");
  assert.equal((await app.request(withQuery(url, { download: "1" }))).status, 403);
  assert.equal((await app.request(withQuery(payload.accessUrls[payload.id], { sig: "invalid", w: "240" }))).status, 403);
  assert.equal((await app.request(`/api/attachments/${payload.id}`)).status, 404);
});

test("损坏的 HEIC 返回明确预览错误，原件仍可下载", async () => {
  const bytes = Buffer.concat([brandBox("heic"), Buffer.from("broken")]);
  const payload = await upload("image/heic", "/api/attachments", bytes);
  const url = payload.accessUrls[payload.id];
  const response = await app.request(url);
  assert.equal(response.status, 422);
  assert.equal((await response.json() as { code: string }).code, "HEIF_PREVIEW_FAILED");
  const original = await app.request(withQuery(url, { download: "1" }));
  assert.equal(original.status, 200);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
});

test("删除附件会清理 HEIF 兼容副本和缩略图，不删除其他附件的缓存", async () => {
  const payload = await upload();
  const url = payload.accessUrls[payload.id];
  assert.equal((await app.request(url)).status, 200);
  assert.equal((await app.request(withQuery(url, { w: "240" }))).status, 200);
  const cache = path.join(attachmentsDir, ".thumbs");
  assert.equal(fs.existsSync(path.join(cache, `${payload.id}_preview.webp`)), true);
  fs.writeFileSync(path.join(cache, "other_preview.webp"), "other");
  const removed = await app.request(`/api/attachments/${payload.id}`, {
    method: "DELETE", headers: { "X-User-Id": owner },
  });
  assert.equal(removed.status, 200);
  assert.equal(fs.existsSync(path.join(cache, `${payload.id}_preview.webp`)), false);
  assert.equal(fs.existsSync(path.join(cache, `${payload.id}_w240.webp`)), false);
  assert.equal(fs.existsSync(path.join(cache, "other_preview.webp")), true);
});

test("公共缩略图服务可直接处理 HEIF 原件，同一附件并发只生成一次预览", async () => {
  const { isThumbnailable, getOrCreateThumbnailFromBufferAsync } = await import("../src/services/thumbnails");
  const { getOrCreateHeifPreview } = await import("../src/services/heif-preview");
  assert.equal(isThumbnailable("image/heic"), true);
  assert.equal(isThumbnailable("image/heif"), true);
  let reads = 0;
  const read = async () => { reads++; return source; };
  const [first, second] = await Promise.all([
    getOrCreateHeifPreview(attachmentsDir, "concurrent", read),
    getOrCreateHeifPreview(attachmentsDir, "concurrent", read),
  ]);
  assert.deepEqual(first, second);
  assert.equal(reads, 1);
  const thumb = await getOrCreateThumbnailFromBufferAsync(attachmentsDir, "concurrent", source, "image/heic", 480);
  assert.ok(thumb);
  assert.equal((await sharp(thumb.buffer).metadata()).width, 480);
});
