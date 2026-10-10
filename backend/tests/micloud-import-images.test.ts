import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import "../src/runtime/knowledge-tree-migration-bootstrap.js";
import { getDb, closeDb } from "../src/db/schema.js";
import miCloudRouter from "../src/routes/micloud.js";
import "../src/runtime/micloud-import-hardening.js";
import "../src/runtime/micloud-import-jobs.js";

const originalFetch = globalThis.fetch;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR4cAAAAASUVORK5CYII=", "base64");
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const firstId = "123456.first_image";
const secondId = "123456.second_image";
let userId: string;
let entry: Record<string, unknown>;
let imageResponse: (id: string) => Response;
let downloads: string[];

beforeEach(() => {
  userId = randomUUID();
  getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(userId, userId, "hash");
  entry = { content: `<img fileid="${firstId}" />`, extraInfo: { title: "照片笔记" } };
  imageResponse = (id) => new Response(id === secondId ? gif : png, {
    headers: { "Content-Type": id === secondId ? "image/gif" : "image/png" },
  });
  downloads = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(new Headers(init?.headers).get("Cookie"), "serviceToken=test");
    assert.ok(url.hostname === "i.mi.com" || url.hostname === "s010.i.mi.com");
    const responseEntry = url.pathname.includes("/good-photo/") ? { ...entry, content: `<img fileid="${firstId}" />` } : entry;
    if (url.pathname.startsWith("/note/note/")) return new Response(JSON.stringify({ data: { entry: responseEntry } }), {
      headers: { "Content-Type": "application/json" },
    });
    const id = url.searchParams.get("fileid") || decodeURIComponent(url.pathname.split("/").pop()!);
    downloads.push(id);
    return imageResponse(id);
  };
});
after(() => { globalThis.fetch = originalFetch; closeDb(); });

async function importPhotoNote() {
  const app = new Hono();
  app.route("/api/micloud", miCloudRouter);
  const response = await app.request("/api/micloud/import", {
    method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": userId },
    body: JSON.stringify({ cookie: "serviceToken=test", noteIds: ["photo-note"] }),
  });
  const payload = await response.json() as { errors?: string[]; error?: string; notes?: Array<{ id: string }> };
  const note = getDb().prepare("SELECT id, content, contentFormat FROM notes WHERE userId = ?").get(userId) as
    { id: string; content: string; contentFormat: string } | undefined;
  const attachments = getDb().prepare("SELECT mimeType, path FROM attachments WHERE userId = ? ORDER BY rowid").all(userId) as
    Array<{ mimeType: string; path: string }>;
  for (const attachment of attachments) {
    const saved = fs.readFileSync(path.join(process.env.ELECTRON_USER_DATA!, "attachments", attachment.path));
    assert.deepEqual(saved, attachment.mimeType === "image/gif" ? gif : png);
  }
  return { response, payload, note, attachments };
}

test("imports indexed image placeholders from setting.data in the original order", async () => {
  entry.content = "☺<0/>\n两张照片之间的文字\n☺<1/>";
  entry.setting = { data: [{ fileId: firstId, mimeType: "image/png" }, { fileId: secondId, mimeType: "image/gif" }] };
  const result = await importPhotoNote();
  assert.equal(result.response.status, 201);
  assert.equal(result.note?.contentFormat, "html");
  assert.match(result.note!.content, /两张照片之间的文字/);
  assert.equal((result.note!.content.match(/<img src="\/api\/attachments\//g) || []).length, 2);
  assert.deepEqual(result.attachments.map((item) => item.mimeType), ["image/png", "image/gif"]);
  assert.deepEqual(downloads, [firstId, secondId]);
});

test("accepts JSON setting metadata and ignores non-image attachments for bare placeholders", async () => {
  entry.content = "☺\n☺";
  entry.setting = JSON.stringify({ data: [
    { fileId: "123456.audio_file", mimeType: "audio/mpeg" },
    { fileId: firstId, mimeType: "image/png" }, { fileId: secondId, mimeType: "image/gif" },
  ] });
  const result = await importPhotoNote();
  assert.equal(result.attachments.length, 2);
  assert.deepEqual(downloads, [firstId, secondId]);
});

test("preserves legacy extraInfo image metadata", async () => {
  entry.content = "☺<0/>\n☺<1/>";
  entry.extraInfo = JSON.stringify({ imgs: [firstId, { fileId: secondId }] });
  assert.equal((await importPhotoNote()).attachments.length, 2);
});

test("downloads Xiaomi src URLs and stores stable local attachment URLs", async () => {
  entry.content = `<img src="/file/full?type=note_img&amp;fileid=${firstId}" />\n<img src="https://s010.i.mi.com/note/file/${secondId}" />`;
  const result = await importPhotoNote();
  assert.equal(result.attachments.length, 2);
  assert.doesNotMatch(result.note!.content, /i\.mi\.com|\/file\/full/);
});

test("downloads a repeated image once while keeping every occurrence", async () => {
  entry.content = `<img fileid="${firstId}" />\n<img fileid="${firstId}" />`;
  const result = await importPhotoNote();
  assert.equal((result.note!.content.match(/<img /g) || []).length, 2);
  assert.deepEqual(downloads, [firstId]);
});

test("recognizes photo bytes served as binary instead of requiring an image Content-Type", async () => {
  imageResponse = () => new Response(png, { headers: { "Content-Type": "application/octet-stream" } });
  const result = await importPhotoNote();
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].mimeType, "image/png");
});

test("does not mark an image download failure as a successful text-only import", async () => {
  imageResponse = () => new Response("unavailable", { status: 503 });
  const result = await importPhotoNote();
  assert.equal(result.response.status, 500);
  assert.equal(result.note, undefined);
  assert.equal(result.attachments.length, 0);
  assert.match(JSON.stringify(result.payload), /图片.*失败/);
});

test("does not save a login/error page as photo bytes even when it claims to be JPEG", async () => {
  imageResponse = () => new Response("<html>sign in</html>", { headers: { "Content-Type": "image/jpeg" } });
  const result = await importPhotoNote();
  assert.equal(result.response.status, 500);
  assert.equal(result.note, undefined);
});

test("reports unresolved indexed photos instead of silently removing them", async () => {
  entry.content = "☺<0/>";
  const result = await importPhotoNote();
  assert.equal(result.response.status, 500);
  assert.equal(result.note, undefined);
  assert.match(JSON.stringify(result.payload), /图片/);
});

test("does not send Xiaomi credentials to unrelated img src URLs", async () => {
  entry.content = `<img src="https://example.com/file/full?fileid=${firstId}" />`;
  const result = await importPhotoNote();
  assert.equal(result.response.status, 201);
  assert.match(result.note!.content, /https:\/\/example.com/);
  assert.deepEqual(downloads, []);
});

test("keeps failed photos retryable without reimporting successful notes", async () => {
  entry.content = `<img fileid="${secondId}" />`;
  imageResponse = (id) => id === firstId ? new Response(png, { headers: { "Content-Type": "image/png" } })
    : new Response("unavailable", { status: 503 });
  const app = new Hono();
  app.route("/api/micloud", miCloudRouter);
  const headers = { "Content-Type": "application/json", "X-User-Id": userId };
  type Job = { id: string; status: string; succeeded: number; failed: number; total: number; errors: string[] };
  const waitForJob = async (id: string): Promise<Job> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const response = await app.request(`/api/micloud/import-jobs/${id}`, { headers });
      assert.equal(response.status, 200);
      const { job } = await response.json() as { job: Job };
      if (["completed", "partial", "failed"].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("photo import job timed out");
  };
  const created = await app.request("/api/micloud/import-jobs", {
    method: "POST", headers, body: JSON.stringify({ cookie: "serviceToken=test", noteIds: ["good-photo", "bad-photo"] }),
  });
  assert.equal(created.status, 202);
  const { job } = await created.json() as { job: Job };
  const partial = await waitForJob(job.id);
  assert.equal(partial.status, "partial");
  assert.equal(partial.succeeded, 1);
  assert.equal(partial.failed, 1);
  assert.match(partial.errors[0], /图片下载失败/);
  imageResponse = (id) => new Response(id === secondId ? gif : png, {
    headers: { "Content-Type": id === secondId ? "image/gif" : "image/png" },
  });
  const retried = await app.request(`/api/micloud/import-jobs/${job.id}/retry-failed`, {
    method: "POST", headers, body: JSON.stringify({ cookie: "serviceToken=test" }),
  });
  assert.equal(retried.status, 202);
  const { job: retryJob } = await retried.json() as { job: Job };
  const completed = await waitForJob(retryJob.id);
  assert.equal(completed.total, 1);
  assert.equal(completed.status, "completed");
  assert.equal(completed.succeeded, 1);
  const count = getDb().prepare("SELECT COUNT(*) AS count FROM notes WHERE userId = ?").get(userId) as { count: number };
  assert.equal(count.count, 2);
  assert.equal(downloads.filter((id) => id === firstId).length, 1);
});
