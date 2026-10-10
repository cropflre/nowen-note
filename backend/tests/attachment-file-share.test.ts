import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-file-share-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.ATTACHMENT_LEGACY_PUBLIC_URL = "false";
process.env.ATTACHMENT_SIGNING_SECRET = "test-file-share-signing-secret-770";

const OWNER_ID = "file-share-owner";
const NOTEBOOK_ID = "file-share-notebook";
const NOTE_ID = "file-share-note";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let attachmentId = "";

function db() {
  return getDb();
}

function publicRoute(url: string): string {
  const parsed = new URL(url, "http://localhost");
  return `${parsed.pathname.replace(/^\/api/, "")}${parsed.search}`;
}

async function responseJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function createStableShare(options: Record<string, unknown> = {}) {
  const response = await app.request("/attachments/file-share", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": OWNER_ID,
    },
    body: JSON.stringify({ attachmentId, ...options }),
  });
  assert.equal(response.status, 200);
  return responseJson<{
    id: string;
    attachmentId: string;
    url: string;
    allowDownload: boolean;
    expiresAt: string | null;
  }>(response);
}

test.before(async () => {
  const [attachmentsModule, schemaModule] = await Promise.all([
    import("../src/routes/attachments"),
    import("../src/db/schema"),
  ]);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  app = new Hono();
  app.get("/attachments/:id", attachmentsModule.handleDownloadAttachment);
  app.route("/attachments", attachmentsModule.default);

  const database = db();
  database
    .prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(OWNER_ID, OWNER_ID, "hash");
  database
    .prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(NOTEBOOK_ID, OWNER_ID, "File share notebook");
  database
    .prepare(
      `INSERT INTO notes (id, userId, notebookId, title, content, contentText)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(NOTE_ID, OWNER_ID, NOTEBOOK_ID, "File share note", "{}", "File share note");

  const form = new FormData();
  form.set("noteId", NOTE_ID);
  form.set("file", new File([new Uint8Array([7, 7, 0])], "stable-share.pdf", {
    type: "application/pdf",
  }));
  const upload = await app.request("/attachments", {
    method: "POST",
    headers: { "X-User-Id": OWNER_ID },
    body: form,
  });
  assert.equal(upload.status, 201);
  attachmentId = (await responseJson<{ id: string }>(upload)).id;
  assert.ok(attachmentId);
});

test.after(() => {
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
  }
});

test("stable file-share URL contains no temporary attachment signature and survives normal access", async () => {
  const share = await createStableShare();
  const parsed = new URL(share.url, "http://localhost");

  assert.equal(share.attachmentId, attachmentId);
  assert.ok(parsed.searchParams.get("share"));
  assert.equal(parsed.searchParams.get("exp"), null);
  assert.equal(parsed.searchParams.get("sig"), null);
  assert.equal(parsed.searchParams.get("scope"), null);

  const response = await app.request(publicRoute(share.url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-cache, must-revalidate, no-transform",
  );
});

test("revoke invalidates the stable URL before ETag short-circuiting", async () => {
  const share = await createStableShare();
  const before = await app.request(publicRoute(share.url));
  assert.equal(before.status, 200);
  const etag = before.headers.get("etag");
  assert.ok(etag);

  const revoke = await app.request(`/attachments/file-share/${attachmentId}`, {
    method: "DELETE",
    headers: { "X-User-Id": OWNER_ID },
  });
  assert.equal(revoke.status, 200);

  const after = await app.request(publicRoute(share.url), {
    headers: { "If-None-Match": etag as string },
  });
  assert.equal(after.status, 410);
  const denied = await responseJson<{ code: string }>(after);
  assert.equal(denied.code, "FILE_SHARE_REVOKED");
});

test("allowDownload=false blocks explicit download while keeping inline access available", async () => {
  const share = await createStableShare({ allowDownload: false });
  assert.equal(share.allowDownload, false);

  const inline = await app.request(publicRoute(share.url));
  assert.equal(inline.status, 200);

  const downloadUrl = new URL(share.url, "http://localhost");
  downloadUrl.searchParams.set("download", "1");
  const download = await app.request(publicRoute(downloadUrl.toString()));
  assert.equal(download.status, 403);
  const denied = await responseJson<{ code: string }>(download);
  assert.equal(denied.code, "ATTACHMENT_DOWNLOAD_FORBIDDEN");
});

test("expired stable shares return a product-level expiry error instead of INVALID_SIGNATURE", async () => {
  const share = await createStableShare({
    allowDownload: true,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  db().prepare("UPDATE file_shares SET expiresAt = datetime('now', '-1 minute') WHERE id = ?")
    .run(share.id);

  const response = await app.request(publicRoute(share.url));
  assert.equal(response.status, 410);
  const denied = await responseJson<{ code: string; error: string }>(response);
  assert.equal(denied.code, "FILE_SHARE_EXPIRED");
  assert.match(denied.error, /过期/);
});

test("deleting the attachment invalidates its stable share", async () => {
  // Previous test expired the active share. A new creation rotates to a fresh token.
  const share = await createStableShare();
  db().prepare("DELETE FROM attachments WHERE id = ?").run(attachmentId);

  const response = await app.request(publicRoute(share.url));
  assert.equal(response.status, 404);
  const denied = await responseJson<{ code: string }>(response);
  assert.equal(denied.code, "FILE_SHARE_NOT_FOUND");
});
