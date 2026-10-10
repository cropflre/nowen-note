import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import sharp from "sharp";
import { Hono } from "hono";
import { analyzeModernMedia } from "../src/lib/modern-media";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-modern-media-"));
process.env.DB_PATH = path.join(tmp, "test.db");
process.env.ELECTRON_USER_DATA = tmp;
process.env.NODE_ENV = "test";
process.env.ATTACHMENT_LEGACY_PUBLIC_URL = "false";
process.env.ATTACHMENT_SIGNING_SECRET = "modern-media-secret";
const assetId = "a8e6eead-1122-4455-aabb-123456789abc";
const owner = "photo-owner";
let jpeg: Buffer;
let mov: Buffer;
let app: Hono;
let schema: typeof import("../src/db/schema");
let core: typeof import("../src/routes/attachments-core");
let mediaService: typeof import("../src/services/modern-media");

function box(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length + 8); header.write(type, 4);
  return Buffer.concat([header, data]);
}
function app1(bytes: Buffer): Buffer {
  const header = Buffer.from([0xff, 0xe1, 0, 0]); header.writeUInt16BE(bytes.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, bytes, jpeg.subarray(2)]);
}
function xmp(xml: string): Buffer {
  return app1(Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${xml}</rdf:RDF></x:xmpmeta>`));
}
function motionPhoto(flag = "1", length = mov.length): Buffer {
  return Buffer.concat([xmp(`<rdf:Description xmlns:Cam="http://ns.google.com/photos/1.0/camera/" xmlns:C="http://ns.google.com/photos/1.0/container/" xmlns:I="http://ns.google.com/photos/1.0/container/item/" Cam:MotionPhoto="${flag}" Cam:MicroVideo="1" Cam:MicroVideoOffset="${mov.length}"><C:Directory><rdf:Seq><rdf:li><C:Item I:Semantic="Primary" I:Mime="image/jpeg" I:Length="0"/></rdf:li><rdf:li><C:Item I:Semantic="MotionPhoto" I:Mime="video/quicktime" I:Length="${length}"/></rdf:li></rdf:Seq></C:Directory></rdf:Description>`), mov]);
}
function applePhoto(identifier = assetId): Buffer {
  const maker = Buffer.alloc(16 + 12 + 37);
  maker.write("Apple iOS\0", 0, "ascii"); maker.writeUInt16BE(1, 10); maker.write("MM", 12);
  maker.writeUInt16BE(1, 14); maker.writeUInt16BE(0x11, 16); maker.writeUInt16BE(2, 18);
  maker.writeUInt32BE(37, 20); maker.writeUInt32BE(28, 24); maker.write(identifier, 28);
  // 标准 EXIF TIFF → ExifIFD → MakerNote，偏移以 TIFF 起点计算。
  const tiff = Buffer.alloc(44); tiff.write("MM", 0); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); tiff.writeUInt16BE(0x8769, 10); tiff.writeUInt16BE(4, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt32BE(26, 18);
  tiff.writeUInt16BE(1, 26); tiff.writeUInt16BE(0x927c, 28); tiff.writeUInt16BE(7, 30); tiff.writeUInt32BE(maker.length, 32); tiff.writeUInt32BE(44, 36);
  return app1(Buffer.concat([Buffer.from("Exif\0\0"), tiff, maker]));
}
function samsungPhoto(pointer = false): Buffer {
  const data = pointer ? Buffer.alloc(12) : mov;
  if (pointer) { data.write("mpv2"); data.writeUInt32BE(jpeg.length, 4); data.writeUInt32BE(mov.length, 8); }
  const name = Buffer.from("MotionPhoto_Data"); const prefix = Buffer.alloc(8);
  prefix.writeUInt16LE(0x0a30, 2); prefix.writeUInt32LE(name.length, 4);
  const block = Buffer.concat([prefix, name, data]);
  const dir = Buffer.alloc(24); dir.write("SEFH"); dir.writeUInt32LE(101, 4); dir.writeUInt32LE(1, 8);
  dir.writeUInt16LE(0x0a30, 14); dir.writeUInt32LE(block.length, 16); dir.writeUInt32LE(block.length, 20);
  const footer = Buffer.alloc(8); footer.writeUInt32LE(dir.length); footer.write("SEFT", 4);
  return Buffer.concat([jpeg, ...(pointer ? [mov] : []), block, dir, footer]);
}
function query(url: string, values: Record<string, string>): string {
  const parsed = new URL(url, "http://localhost");
  Object.entries(values).forEach(([key, value]) => parsed.searchParams.set(key, value));
  return parsed.pathname + parsed.search;
}
async function upload(bytes: Buffer, name: string, noteId = "photo-note") {
  const form = new FormData(); form.set("noteId", noteId); form.set("file", new File([new Uint8Array(bytes)], name));
  const response = await app.request("/api/attachments", { method: "POST", headers: { "X-User-Id": owner }, body: form });
  assert.ok([200, 201].includes(response.status), await response.clone().text());
  const value = await response.json() as { id: string; mimeType: string; category: string; accessUrls: Record<string, string> };
  return { ...value, url: value.accessUrls[value.id] };
}

test.before(async () => {
  const routes = await import("../src/routes/attachments");
  core = await import("../src/routes/attachments-core"); schema = await import("../src/db/schema");
  mediaService = await import("../src/services/modern-media");
  jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#2186a5" } }).jpeg().toBuffer();
  const movie = path.join(tmp, "original.mov");
  execFileSync(mediaService.getMediaFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1", "-c:v", "libx265", "-x265-params", "pools=1:log-level=error", "-pix_fmt", "yuv420p10le", "-c:a", "aac", "-metadata", `com.apple.quicktime.content.identifier=${assetId}`, "-movflags", "use_metadata_tags", movie], { windowsHide: true });
  mov = fs.readFileSync(movie);
  const db = schema.getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(owner, owner, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run("photo-book", owner, "照片");
  for (const id of ["photo-note", "private-note"]) db.prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, ?, ?, ?)").run(id, owner, "photo-book", id, "{}");
  app = new Hono(); app.get("/api/attachments/:id", routes.handleDownloadAttachment); app.route("/api/attachments", routes.default);
});
test.after(() => { schema?.closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("按真实字节识别 JPEG、HEIF、MOV，Apple 原件的 UUID 对应而非文件名对应", () => {
  assert.equal(analyzeModernMedia(jpeg).mimeType, "image/jpeg");
  assert.equal(analyzeModernMedia(mov).mimeType, "video/quicktime");
  assert.equal(analyzeModernMedia(mov).assetIdentifier, assetId);
  assert.equal(analyzeModernMedia(applePhoto()).assetIdentifier, assetId);
  assert.equal(analyzeModernMedia(applePhoto()).kind, "live-photo");
});

test("Pixel 新 Container、旧 MicroVideo、HEIC mpvd 和三星两种 SEFT 均提取完整真实视频", () => {
  const old = Buffer.concat([xmp(`<rdf:Description xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" GCamera:MicroVideo="1" GCamera:MicroVideoOffset="${mov.length}"/>`), mov]);
  const heic = fs.readFileSync(path.join(__dirname, "fixtures/heif/example.heic"));
  for (const source of [motionPhoto(), old, Buffer.concat([heic, box("mpvd", mov)]), samsungPhoto(), samsungPhoto(true)]) {
    const analysis = analyzeModernMedia(source);
    assert.equal(analysis.kind, "motion-photo"); assert.ok(analysis.motion);
    assert.deepEqual(source.subarray(analysis.motion.offset, analysis.motion.offset + analysis.motion.length), mov);
  }
});

test("拒绝损坏和越界偏移、伪装视频与明确关闭的动态照片", () => {
  assert.equal(analyzeModernMedia(motionPhoto("0")).motion, undefined);
  assert.equal(analyzeModernMedia(motionPhoto("1", Number.MAX_SAFE_INTEGER)).motion, undefined);
  const bad = motionPhoto(); bad.fill(0, bad.length - mov.length, bad.length);
  assert.equal(analyzeModernMedia(bad).motion, undefined);
  const corrupt = samsungPhoto(); corrupt.writeUInt32LE(0xffffffff, corrupt.length - 8);
  assert.equal(analyzeModernMedia(corrupt).motion, undefined);
});

test("存量 JPEG 与 MOV 命中去重时按真实字节修正分类", async () => {
  for (const [bytes, name, mimeType, category] of [[jpeg, "旧照片.jpg", "image/jpeg", "image"], [mov, "旧动态.mov", "video/quicktime", "file"]] as const) {
    const created: string[] = [];
    try {
      const original = await upload(bytes, name); created.push(original.id);
      schema.getDb().prepare("UPDATE attachments SET mimeType = ? WHERE id = ?").run("application/octet-stream", original.id);
      const duplicate = await upload(bytes, name, "private-note"); created.push(duplicate.id);
      assert.equal(duplicate.mimeType, mimeType); assert.equal(duplicate.category, category);
    } finally {
      for (const id of created) await app.request(`/api/attachments/${id}`, { method: "DELETE", headers: { "X-User-Id": owner } });
    }
  }
});

test("动态照片存原件、懒转 H.264/AAC、缓存复用，Range、If-Range 和签名隔离正常", async () => {
  const source = motionPhoto(); const item = await upload(source, "Pixel.jpg");
  assert.equal(item.category, "image"); assert.equal(item.mimeType, "image/jpeg");
  const info = await app.request(query(item.url, { media: "info" })); assert.equal((await info.json()).hasMotion, true);
  const url = query(item.url, { variant: "motion", inline: "1" });
  const [first, second] = await Promise.all([app.request(url), app.request(url)]);
  assert.equal(first.status, 200, await first.clone().text());
  const bytes = Buffer.from(await first.arrayBuffer()); assert.deepEqual(Buffer.from(await second.arrayBuffer()), bytes);
  assert.equal(first.headers.get("content-type"), "video/mp4"); assert.notEqual(first.headers.get("content-disposition"), "attachment");
  assert.ok(bytes.includes(Buffer.from("avc1"))); assert.ok(bytes.includes(Buffer.from("mp4a")));
  assert.ok(mov.includes(Buffer.from("hev1")) || mov.includes(Buffer.from("hvc1")));
  const range = await app.request(url, { headers: { Range: "bytes=10-29" } }); assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 10-29/${bytes.length}`); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(10, 30));
  assert.equal((await app.request(url, { headers: { Range: "bytes=999999999-" } })).status, 416);
  assert.equal((await app.request(url, { headers: { Range: "bytes=10-29", "If-Range": '"old"' } })).status, 200);
  assert.equal((await app.request(url, { headers: { "If-None-Match": first.headers.get("etag")! } })).status, 304);
  assert.equal((await app.request(`/api/attachments/${item.id}?variant=motion`)).status, 404);
  assert.equal((await app.request(query(url, { sig: "invalid" }))).status, 403);
  const raw = await app.request(query(url, { download: "1" })); assert.deepEqual(Buffer.from(await raw.arrayBuffer()), source);
  const cache = schema.getDb().prepare("SELECT storagePath FROM attachment_media_variants WHERE sourceAttachmentId = ? AND kind = 'motion-mp4'").get(item.id) as { storagePath: string };
  assert.ok(fs.existsSync(path.join(tmp, "attachments", cache.storagePath)));
  const removed = await app.request(`/api/attachments/${item.id}`, { method: "DELETE", headers: { "X-User-Id": owner } }); assert.equal(removed.status, 200);
  assert.equal(fs.existsSync(path.join(tmp, "attachments", cache.storagePath)), false);
  assert.equal(schema.getDb().prepare("SELECT 1 FROM attachment_media_variants WHERE sourceAttachmentId = ?").get(item.id), undefined);
});

test("Live Photo 自动关联同笔记 UUID，动态原件可下载，缺失伴随文件仍有静态封面", async () => {
  const still = await upload(applePhoto(), "IMG_0001.JPG");
  assert.equal((await (await app.request(query(still.url, { media: "info" }))).json()).motionStatus, "missing-companion");
  await upload(mov, "IMG_0001.MOV", "private-note");
  assert.equal((await (await app.request(query(still.url, { media: "info" }))).json()).hasMotion, false);
  const companion = await upload(mov, "不同文件名.MOV");
  assert.equal((await (await app.request(query(still.url, { media: "info" }))).json()).kind, "live-photo");
  assert.equal((await app.request(query(still.url, { variant: "motion" }))).status, 200);
  const raw = await app.request(query(still.url, { variant: "motion-original", download: "1" })); assert.deepEqual(Buffer.from(await raw.arrayBuffer()), mov);
  const limited = await app.request("/api/attachments/file-share", { method: "POST", headers: { "X-User-Id": owner, "Content-Type": "application/json" }, body: JSON.stringify({ attachmentId: still.id, allowDownload: false }) });
  const limitedUrl = (await limited.json() as { url: string }).url;
  const limitedInfo = await (await app.request(query(limitedUrl, { media: "info" }))).json();
  assert.equal(limitedInfo.hasMotionOriginal, true); assert.equal(limitedInfo.canDownloadOriginal, false); assert.equal(limitedInfo.accessUrls, undefined);
  assert.equal((await app.request(query(limitedUrl, { variant: "motion-original", download: "1" }))).status, 403);
  schema.getDb().prepare("UPDATE notes SET content = ? WHERE id = ?").run(`/api/attachments/${still.id}`, "photo-note");
  assert.ok(!core.scanOrphanAttachments(0).contentOrphans.some((row) => row.id === companion.id));
  const backup = path.join(tmp, "snapshot.db"); await schema.getDb().backup(backup);
  const restored = new Database(backup, { readonly: true });
  assert.equal((restored.prepare("SELECT variantAttachmentId FROM attachment_media_variants WHERE sourceAttachmentId = ? AND kind = 'original-motion'").get(still.id) as { variantAttachmentId: string }).variantAttachmentId, companion.id); restored.close();
  await app.request(`/api/attachments/${companion.id}`, { method: "DELETE", headers: { "X-User-Id": owner } });
  assert.equal((await (await app.request(query(still.url, { media: "info" }))).json()).motionStatus, "missing-companion");
  assert.equal((await app.request(still.url)).status, 200);
});

test("存量照片无需重传即可分析；转码失败不改变原件和静态图", async () => {
  const source = motionPhoto(); const item = await upload(source, "历史照片.jpg");
  schema.getDb().prepare("DELETE FROM attachment_media_variants WHERE sourceAttachmentId = ?").run(item.id);
  assert.equal((await (await app.request(query(item.url, { media: "info" }))).json()).hasMotion, true);
  const previous = process.env.FFMPEG_PATH; process.env.FFMPEG_PATH = path.join(tmp, "missing-ffmpeg.exe");
  try { assert.equal((await app.request(query(item.url, { variant: "motion" }))).status, 422); }
  finally { if (previous) process.env.FFMPEG_PATH = previous; else delete process.env.FFMPEG_PATH; }
  assert.deepEqual(Buffer.from(await (await app.request(item.url)).arrayBuffer()), source);
  assert.deepEqual(Buffer.from(await (await app.request(query(item.url, { download: "1" }))).arrayBuffer()), source);
});

test("HEIF 动态照片同时具有 WebP 封面、MP4 播放与原始 HEIC 下载", async () => {
  const heic = fs.readFileSync(path.join(__dirname, "fixtures/heif/example.heic"));
  const source = Buffer.concat([heic, box("mpvd", mov)]); const item = await upload(source, "Motion.HEIC");
  assert.equal(item.mimeType, "image/heic");
  const preview = await app.request(item.url); assert.equal(preview.status, 200); assert.equal(preview.headers.get("content-type"), "image/webp");
  const metadata = await sharp(Buffer.from(await preview.arrayBuffer())).metadata(); assert.equal(metadata.width, 1280);
  assert.equal((await app.request(query(item.url, { variant: "motion" }))).status, 200);
  assert.deepEqual(Buffer.from(await (await app.request(query(item.url, { download: "1" }))).arrayBuffer()), source);
  const shareResponse = await app.request("/api/attachments/file-share", { method: "POST", headers: { "X-User-Id": owner, "Content-Type": "application/json" }, body: JSON.stringify({ attachmentId: item.id, allowDownload: false }) });
  assert.equal(shareResponse.status, 200); const share = await shareResponse.json() as { url: string };
  const shareInfo = await (await app.request(query(share.url, { media: "info" }))).json();
  assert.equal(shareInfo.accessUrls, undefined); assert.equal(shareInfo.canDownloadOriginal, false);
  assert.equal((await app.request(query(share.url, { variant: "motion" }))).status, 200);
  assert.equal((await app.request(query(share.url, { download: "1" }))).status, 403);
  assert.equal((await app.request(query(share.url, { variant: "motion-original", download: "1" }))).status, 403);
});
