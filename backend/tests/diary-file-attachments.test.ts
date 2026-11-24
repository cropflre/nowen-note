import "./setup-db-isolation";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { Hono } from "hono";

import { closeDb, getDb } from "../src/db/schema";
import diaryRouter, { handleDownloadDiaryImage } from "../src/routes/diary";

/**
 * Issue #928：说说支持任意文件附件。
 *
 * 附件与图片/视频分开存放（diaries.attachments），上传策略沿用任务附件
 * （默认 100MB、拦截可执行/脚本类），只能由用户在发布或编辑时显式增删。
 */

const OWNER = "diary-file-owner";
const OTHER = "diary-file-other";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0n0AAAAASUVORK5CYII=",
  "base64",
);

const app = new Hono();
app.get("/api/diary/attachments/:id", handleDownloadDiaryImage);
app.route("/api/diary", diaryRouter);

after(() => closeDb());

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM diary_attachments; DELETE FROM diaries;");
  for (const id of [OWNER, OTHER]) {
    db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, 'x')").run(id, id);
  }
});

function call(user: string, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-User-Id", user);
  return Promise.resolve(app.request(url, { ...init, headers }));
}

function sendJson(user: string, url: string, method: "POST" | "PUT", body: unknown): Promise<Response> {
  return call(user, url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function upload(
  user: string,
  file: File,
  kind?: "file",
  query = "",
): Promise<Response> {
  const form = new FormData();
  form.set("file", file);
  if (kind) form.set("kind", kind);
  return call(user, `/api/diary/attachments${query}`, { method: "POST", body: form });
}

async function uploadOk(user: string, file: File, kind?: "file"): Promise<{ id: string; filename: string; mimeType: string; size: number; type: string }> {
  const response = await upload(user, file, kind);
  assert.equal(response.status, 201, await response.clone().text());
  return response.json() as Promise<{ id: string; filename: string; mimeType: string; size: number; type: string }>;
}

function pdf(name = "合同 2026.pdf"): File {
  return new File([Buffer.from("%PDF-1.4\n%%EOF\n")], name, { type: "application/pdf" });
}

function png(name = "photo.png"): File {
  return new File([PNG], name, { type: "image/png" });
}

function storedRow(id: string): { diaryId: string | null; kind: string; filename: string | null; path: string } | undefined {
  return getDb()
    .prepare("SELECT diaryId, kind, filename, path FROM diary_attachments WHERE id = ?")
    .get(id) as { diaryId: string | null; kind: string; filename: string | null; path: string } | undefined;
}

function storedFileExists(relPath: string): boolean {
  return fs.existsSync(path.join(process.env.ELECTRON_USER_DATA as string, "attachments", relPath));
}

test("file attachments keep their original name; executables, scripts and non-members are rejected", async () => {
  const uploaded = await uploadOk(OWNER, pdf(), "file");
  assert.equal(uploaded.type, "file");
  assert.equal(uploaded.filename, "合同 2026.pdf");
  assert.equal(uploaded.mimeType, "application/pdf");
  const row = storedRow(uploaded.id);
  assert.equal(row?.kind, "file");
  assert.equal(row?.filename, "合同 2026.pdf");
  assert.equal(row?.diaryId, null);
  assert.ok(storedFileExists(row!.path));

  const media = await uploadOk(OWNER, png());
  assert.equal(media.type, "image");
  assert.equal(storedRow(media.id)?.kind, "media");

  const before = (getDb().prepare("SELECT COUNT(*) AS count FROM diary_attachments").get() as { count: number }).count;
  for (const blocked of [
    new File([Buffer.from("MZ")], "setup.exe", { type: "application/x-msdownload" }),
    new File([Buffer.from("echo hi")], "run.sh", { type: "application/octet-stream" }),
    new File([Buffer.from("<script>alert(1)</script>")], "page.html", { type: "text/html" }),
    new File([Buffer.from("<svg/>")], "logo.svg", { type: "image/svg+xml" }),
  ]) {
    assert.equal((await upload(OWNER, blocked, "file")).status, 415, blocked.name);
  }
  assert.equal((await upload(OWNER, pdf(), "file", "?workspaceId=not-a-member")).status, 403);
  const afterCount = (getDb().prepare("SELECT COUNT(*) AS count FROM diary_attachments").get() as { count: number }).count;
  assert.equal(afterCount, before);
});

test("file attachment size follows MAX_ATTACHMENT_SIZE_MB instead of the 10MB image limit", async () => {
  const original = process.env.MAX_ATTACHMENT_SIZE_MB;
  process.env.MAX_ATTACHMENT_SIZE_MB = "1";
  try {
    const tooLarge = new File([Buffer.alloc(1024 * 1024 + 1)], "archive.zip", { type: "application/zip" });
    assert.equal((await upload(OWNER, tooLarge, "file")).status, 413);
    const fits = new File([Buffer.alloc(1024 * 1024)], "archive.zip", { type: "application/zip" });
    assert.equal((await upload(OWNER, fits, "file")).status, 201);
  } finally {
    if (original === undefined) delete process.env.MAX_ATTACHMENT_SIZE_MB;
    else process.env.MAX_ATTACHMENT_SIZE_MB = original;
  }
});

test("attachments do not use the 9-image quota and keep their order and metadata", async () => {
  const images = [];
  for (let index = 0; index < 9; index += 1) images.push(await uploadOk(OWNER, png(`p${index}.png`)));
  const first = await uploadOk(OWNER, pdf("发票.pdf"), "file");
  const second = await uploadOk(OWNER, new File([Buffer.from("PK")], "资料.zip", { type: "application/zip" }), "file");

  const response = await sendJson(OWNER, "/api/diary", "POST", {
    contentText: "",
    media: images.map((image) => ({ id: image.id, type: "image" })),
    images: images.map((image) => image.id),
    attachments: [{ id: second.id }, first.id],
  });
  assert.equal(response.status, 201, await response.clone().text());
  const diary = await response.json() as { id: string; images: string[]; media: unknown[]; attachments: unknown[] };
  assert.equal(diary.images.length, 9);
  assert.equal(diary.media.length, 9);
  assert.deepEqual(diary.attachments, [
    { id: second.id, filename: "资料.zip", mimeType: "application/zip", size: 2 },
    { id: first.id, filename: "发票.pdf", mimeType: "application/pdf", size: first.size },
  ]);
  for (const id of [...images.map((image) => image.id), first.id, second.id]) {
    assert.equal(storedRow(id)?.diaryId, diary.id);
  }

  const onlyFile = await uploadOk(OWNER, pdf("周记.pdf"), "file");
  const attachmentOnly = await sendJson(OWNER, "/api/diary", "POST", { contentText: "", attachments: [onlyFile.id] });
  assert.equal(attachmentOnly.status, 201);

  const timeline = await (await call(OWNER, "/api/diary/timeline")).json() as { items: Array<{ id: string; attachments: Array<{ id: string }> }> };
  const listed = timeline.items.find((item) => item.id === diary.id);
  assert.deepEqual(listed?.attachments.map((item) => item.id), [second.id, first.id]);
});

test("attachment ids cannot be swapped with media, reused, or taken from another user", async () => {
  const media = await uploadOk(OWNER, png());
  const file = await uploadOk(OWNER, pdf(), "file");
  const imageAsFile = await uploadOk(OWNER, png("扫描件.png"), "file");
  const foreign = await uploadOk(OTHER, pdf("别人的.pdf"), "file");

  const rejected = [
    { contentText: "x", attachments: [media.id] },
    { contentText: "x", media: [{ id: imageAsFile.id, type: "image" }], images: [imageAsFile.id] },
    { contentText: "x", attachments: [foreign.id] },
  ];
  for (const body of rejected) {
    assert.equal((await sendJson(OWNER, "/api/diary", "POST", body)).status, 400, JSON.stringify(body));
  }
  for (const id of [media.id, file.id, imageAsFile.id, foreign.id]) assert.equal(storedRow(id)?.diaryId, null);

  const published = await sendJson(OWNER, "/api/diary", "POST", { contentText: "x", attachments: [file.id] });
  assert.equal(published.status, 201);
  assert.equal((await sendJson(OWNER, "/api/diary", "POST", { contentText: "y", attachments: [file.id] })).status, 400);
});

test("editing media keeps attachments; only attachments explicitly removed are deleted", async () => {
  const media = await uploadOk(OWNER, png());
  const keep = await uploadOk(OWNER, pdf("保留.pdf"), "file");
  const drop = await uploadOk(OWNER, pdf("移除.pdf"), "file");
  const created = await (await sendJson(OWNER, "/api/diary", "POST", {
    contentText: "带附件的说说",
    media: [{ id: media.id, type: "image" }],
    images: [media.id],
    attachments: [keep.id, drop.id],
  })).json() as { id: string };
  const mediaPath = storedRow(media.id)!.path;
  const dropPath = storedRow(drop.id)!.path;

  const mediaEdit = await sendJson(OWNER, `/api/diary/${created.id}`, "PUT", { media: [], images: [] });
  assert.equal(mediaEdit.status, 200, await mediaEdit.clone().text());
  const afterMediaEdit = await mediaEdit.json() as { media: unknown[]; attachments: Array<{ id: string }> };
  assert.deepEqual(afterMediaEdit.media, []);
  assert.deepEqual(afterMediaEdit.attachments.map((item) => item.id), [keep.id, drop.id]);
  assert.equal(storedRow(media.id), undefined);
  assert.equal(storedFileExists(mediaPath), false);
  assert.equal(storedRow(keep.id)?.diaryId, created.id);
  assert.equal(storedRow(drop.id)?.diaryId, created.id);

  assert.equal((await sendJson(OTHER, `/api/diary/${created.id}`, "PUT", { attachments: [] })).status, 403);
  assert.equal(storedRow(drop.id)?.diaryId, created.id);

  const added = await uploadOk(OWNER, new File([Buffer.from("a,b")], "表格.csv", { type: "text/csv" }), "file");
  const fileEdit = await sendJson(OWNER, `/api/diary/${created.id}`, "PUT", { attachments: [keep.id, added.id] });
  assert.equal(fileEdit.status, 200, await fileEdit.clone().text());
  const afterFileEdit = await fileEdit.json() as { attachments: Array<{ id: string }> };
  assert.deepEqual(afterFileEdit.attachments.map((item) => item.id), [keep.id, added.id]);
  assert.equal(storedRow(drop.id), undefined);
  assert.equal(storedFileExists(dropPath), false);
  assert.equal(storedRow(added.id)?.diaryId, created.id);
  assert.ok(storedFileExists(storedRow(keep.id)!.path));

  const fileOnly = await uploadOk(OWNER, pdf(), "file");
  const onlyAttachment = await (await sendJson(OWNER, "/api/diary", "POST", { contentText: "", attachments: [fileOnly.id] })).json() as { id: string };
  assert.equal((await sendJson(OWNER, `/api/diary/${onlyAttachment.id}`, "PUT", { attachments: [] })).status, 400);
  assert.equal(storedRow(fileOnly.id)?.diaryId, onlyAttachment.id);
});

test("file downloads are private, nosniff and only inline for previewable types", async () => {
  const zip = await uploadOk(OWNER, new File([Buffer.from("PK\u0003\u0004")], "资料 包.zip", { type: "application/zip" }), "file");
  const zipResponse = await app.request(`/api/diary/attachments/${zip.id}`);
  assert.equal(zipResponse.status, 200);
  assert.equal(zipResponse.headers.get("content-disposition"), `attachment; filename*=UTF-8''${encodeURIComponent("资料 包.zip")}`);
  assert.equal(zipResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(zipResponse.headers.get("cache-control"), "private, max-age=3600");

  const document = await uploadOk(OWNER, pdf(), "file");
  const inline = await app.request(`/api/diary/attachments/${document.id}?inline=1`);
  assert.equal(inline.headers.get("content-type"), "application/pdf");
  assert.equal(inline.headers.get("content-disposition"), null);
  const forced = await app.request(`/api/diary/attachments/${document.id}?download=1`);
  assert.match(forced.headers.get("content-disposition") || "", /^attachment; filename\*=UTF-8''/);

  const audio = await uploadOk(OWNER, new File([Buffer.from("0123456789")], "语音.mp3", { type: "audio/mpeg" }), "file");
  const ranged = await app.request(`/api/diary/attachments/${audio.id}`, { headers: { Range: "bytes=2-5" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await ranged.text(), "2345");

  const image = await uploadOk(OWNER, png());
  const imageResponse = await app.request(`/api/diary/attachments/${image.id}`);
  assert.equal(imageResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(imageResponse.headers.get("content-disposition"), null);
});

test("deleting a diary removes its attachment files; the text-only filter skips attachment posts", async () => {
  const file = await uploadOk(OWNER, pdf(), "file");
  const withFile = await (await sendJson(OWNER, "/api/diary", "POST", { contentText: "有附件", attachments: [file.id] })).json() as { id: string };
  const textOnly = await (await sendJson(OWNER, "/api/diary", "POST", { contentText: "只有文字" })).json() as { id: string };

  const filtered = await (await call(OWNER, "/api/diary/timeline?mediaType=text")).json() as { items: Array<{ id: string }> };
  assert.deepEqual(filtered.items.map((item) => item.id), [textOnly.id]);
  const stats = await (await call(OWNER, "/api/diary/stats?mediaType=text")).json() as { total: number };
  assert.equal(stats.total, 1);

  const filePath = storedRow(file.id)!.path;
  assert.equal((await call(OTHER, `/api/diary/${withFile.id}`, { method: "DELETE" })).status, 403);
  assert.ok(storedFileExists(filePath));
  assert.equal((await call(OWNER, `/api/diary/${withFile.id}`, { method: "DELETE" })).status, 200);
  assert.equal(storedRow(file.id), undefined);
  assert.equal(storedFileExists(filePath), false);
});
