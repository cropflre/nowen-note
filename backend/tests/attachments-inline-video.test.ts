import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-attachment-video-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.ATTACHMENT_LEGACY_PUBLIC_URL = "false";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let loginToken = "";

const USER_ID = "user-video";
const NOTEBOOK_ID = "nb-video";
const NOTE_ID = "note-video";

function db() {
  return getDb();
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${loginToken}`, ...extra };
}

function seedBase() {
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  db().prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NOTEBOOK_ID, USER_ID, "NB");
  db().prepare(`
    INSERT OR IGNORE INTO notes (id, userId, notebookId, title, content, contentText)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(NOTE_ID, USER_ID, NOTEBOOK_ID, "Video", "{}", "Video");
}

async function uploadVideo(options: { type?: string; filename?: string; seed?: number } = {}) {
  const type = options.type ?? "video/mp4";
  const filename = options.filename ?? "clip.mp4";
  const seed = options.seed ?? 7;
  const form = new FormData();
  form.set("noteId", NOTE_ID);
  form.set(
    "file",
    new File([new Uint8Array([0, 1, 2, 3, 4, 5, 6, seed])], filename, { type }),
  );
  const res = await app.request("/attachments", {
    method: "POST",
    headers: { "X-User-Id": USER_ID },
    body: form,
  });
  assert.equal(res.status, 201);
  return res.json() as Promise<{
    id: string;
    url: string;
    mimeType: string;
    size: number;
    filename: string;
    category: "image" | "file";
  }>;
}

test.before(async () => {
  const [attachmentsModule, schemaModule, authModule] = await Promise.all([
    import("../src/routes/attachments"),
    import("../src/db/schema"),
    import("../src/lib/auth-security"),
  ]);
  app = new Hono();
  app.get("/attachments/:id", attachmentsModule.handleDownloadAttachment);
  app.route("/attachments", attachmentsModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  seedBase();
  loginToken = authModule.signLoginToken({
    userId: USER_ID,
    username: USER_ID,
    tokenVersion: 0,
  });
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

test("video attachments can be uploaded and previewed inline", async () => {
  const uploaded = await uploadVideo();

  assert.equal(uploaded.mimeType, "video/mp4");
  assert.equal(uploaded.category, "file");
  assert.match(uploaded.url, /^\/api\/attachments\//);

  const inlineRes = await app.request(`/attachments/${uploaded.id}?inline=1`, {
    headers: authHeaders(),
  });

  assert.equal(inlineRes.status, 200);
  assert.equal(inlineRes.headers.get("content-type"), "video/mp4");
  assert.equal(inlineRes.headers.get("content-disposition"), null);
  // no-cache 而非 no-store：允许浏览器留副本，但每次使用前必须回源复核授权。
  assert.equal(
    inlineRes.headers.get("cache-control"),
    "private, no-cache, must-revalidate, no-transform",
  );
});

test("empty Android MIME is normalized from a known video extension", async () => {
  const uploaded = await uploadVideo({
    type: "application/octet-stream",
    filename: "camera-recording.mp4",
    seed: 21,
  });
  assert.equal(uploaded.mimeType, "video/mp4");

  const inlineRes = await app.request(`/attachments/${uploaded.id}?inline=1`, {
    headers: authHeaders(),
  });
  assert.equal(inlineRes.status, 200);
  assert.equal(inlineRes.headers.get("content-type"), "video/mp4");
});

test("legacy octet-stream video rows are repaired lazily before inline playback", async () => {
  const uploaded = await uploadVideo({ filename: "legacy-camera.mp4", seed: 25 });
  db().prepare("UPDATE attachments SET mimeType = 'application/octet-stream' WHERE id = ?")
    .run(uploaded.id);

  const inlineRes = await app.request(`/attachments/${uploaded.id}?inline=1`, {
    headers: authHeaders(),
  });
  assert.equal(inlineRes.status, 200);
  assert.equal(inlineRes.headers.get("content-type"), "video/mp4");

  const repaired = db().prepare("SELECT mimeType FROM attachments WHERE id = ?")
    .get(uploaded.id) as { mimeType: string };
  assert.equal(repaired.mimeType, "video/mp4");
});

test("video attachments respond to browser byte ranges for seeking", async () => {
  const uploaded = await uploadVideo({ seed: 22 });
  const rangeRes = await app.request(`/attachments/${uploaded.id}?inline=1`, {
    headers: authHeaders({ Range: "bytes=2-5" }),
  });

  assert.equal(rangeRes.status, 206);
  assert.equal(rangeRes.headers.get("accept-ranges"), "bytes");
  assert.equal(rangeRes.headers.get("content-range"), "bytes 2-5/8");
  assert.equal(rangeRes.headers.get("content-length"), "4");
  assert.deepEqual(Array.from(new Uint8Array(await rangeRes.arrayBuffer())), [2, 3, 4, 5]);
});

test("unsatisfiable video ranges return RFC-compatible 416 metadata", async () => {
  const uploaded = await uploadVideo({ seed: 23 });
  const rangeRes = await app.request(`/attachments/${uploaded.id}?inline=1`, {
    headers: authHeaders({ Range: "bytes=99-120" }),
  });

  assert.equal(rangeRes.status, 416);
  assert.equal(rangeRes.headers.get("content-range"), "bytes */8");
  assert.equal(rangeRes.headers.get("accept-ranges"), "bytes");
});

test("download=1 keeps video attachments as forced downloads", async () => {
  const uploaded = await uploadVideo({ seed: 24 });

  const downloadRes = await app.request(`/attachments/${uploaded.id}?download=1`, {
    headers: authHeaders(),
  });
  assert.equal(downloadRes.status, 200);
  assert.equal(downloadRes.headers.get("content-type"), "video/mp4");
  assert.match(downloadRes.headers.get("content-disposition") || "", /^attachment;/);
});

test("pre-JWT X-User-Id spoofing is rejected without revealing attachment existence", async () => {
  const uploaded = await uploadVideo({ seed: 26 });
  const response = await app.request(`/attachments/${uploaded.id}`, {
    headers: { "X-User-Id": USER_ID },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "附件不存在",
    code: "ATTACHMENT_NOT_FOUND",
  });
});
