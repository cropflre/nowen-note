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
  app.get("/f/:key", attachmentsModule.handleShortFileShareAttachment);
  app.get("/attachments/:id", attachmentsModule.handleDownloadAttachment);
  app.get("/attachments/:id/:filename{image\\.[a-z]+}", attachmentsModule.handleNamedImageAttachment);
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
  assert.match(parsed.pathname, /^\/api\/f\/[A-Za-z0-9_-]{32}$/);
  assert.equal(parsed.search, "");
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
  const head = await app.request(publicRoute(share.url), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
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

test("named image URLs retain bytes, MIME and ACL through upload, deduplication, sharing and revocation (DCC-006)", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5e0AAAAASUVORK5CYII=", "base64");
  const previousOrigin = process.env.FILE_PUBLIC_ORIGIN;
  process.env.FILE_PUBLIC_ORIGIN = "https://files.example/nowen";
  try {
    const uploadImage = async () => {
      const form = new FormData();
      form.set("noteId", NOTE_ID);
      // The extension must describe the stored MIME, even if the filename differs.
      form.set("file", new File([bytes], "中文 screenshot.jpg", { type: "image/png" }));
      const response = await app.request("/attachments", { method: "POST", headers: { "X-User-Id": OWNER_ID }, body: form });
      assert.equal(response.status, 201);
      return responseJson<{ id: string; url: string; imageUrl: string; deduplicated?: boolean; accessUrls: Record<string, string> }>(response);
    };
    const image = await uploadImage();
    const namedPath = `/attachments/${image.id}/image.png`;
    assert.equal(image.url, `/api/attachments/${image.id}`);
    assert.equal(image.imageUrl, `https://files.example/nowen/api/attachments/${image.id}/image.png`);
    // The public alias must not shadow authenticated /access/urls routing.
    assert.equal((await app.request(`/attachments/access/urls?noteId=${NOTE_ID}`, { headers: { "X-User-Id": OWNER_ID } })).status, 200);
    assert.equal((await app.request(namedPath)).status, 404);
    assert.equal((await app.request(`/attachments/${image.id}/image.jpg`)).status, 404);
    assert.equal((await app.request(`/attachments/${image.id}/unrelated.png`)).status, 404);

    const signed = new URL(image.accessUrls[image.id], "http://localhost");
    const verified = await app.request(`${namedPath}${signed.search}`);
    assert.equal(verified.status, 200);
    assert.equal(verified.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await verified.arrayBuffer()), bytes);
    assert.equal((await app.request(publicRoute(image.accessUrls[image.id]))).status, 200);

    const clone = await uploadImage();
    assert.equal(clone.deduplicated, true);
    assert.notEqual(clone.id, image.id);
    assert.equal(clone.imageUrl, `https://files.example/nowen/api/attachments/${clone.id}/image.png`);

    const createShare = () => app.request("/attachments/file-share", {
      method: "POST", headers: { "X-User-Id": OWNER_ID, "Content-Type": "application/json" },
      body: JSON.stringify({ attachmentId: image.id }),
    });
    const created = await createShare();
    assert.equal(created.status, 200);
    const share = await responseJson<{ url: string }>(created);
    const shortUrl = new URL(share.url);
    assert.match(shortUrl.pathname, /^\/nowen\/api\/f\/[A-Za-z0-9_-]{32}\.png$/);
    assert.equal(shortUrl.search, "");
    const token = shortUrl.pathname.split("/").pop()!.replace(/\.png$/, "");
    const shortRoute = `/f/${token}.png`;
    const shortResponse = await app.request(shortRoute);
    assert.equal(shortResponse.status, 200);
    assert.equal(shortResponse.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await shortResponse.arrayBuffer()), bytes);
    assert.equal((await app.request(`/f/${token}.jpg`)).status, 404);
    assert.equal((await app.request(`/f/${"x".repeat(32)}.png`, { headers: { "X-User-Id": OWNER_ID } })).status, 404);
    // Existing long URLs use the same capability and remain compatible.
    const shareQuery = `?share=${token}`;
    const anonymous = await app.request(`${namedPath}${shareQuery}`);
    assert.equal(anonymous.status, 200);
    assert.deepEqual(Buffer.from(await anonymous.arrayBuffer()), bytes);
    assert.equal((await app.request(`${namedPath}?share=invalid`)).status, 404);
    assert.equal((await app.request(`/attachments/${clone.id}/image.png${shareQuery}`)).status, 404);
    assert.equal((await app.request("/attachments/file-share", {
      method: "POST", headers: { "X-User-Id": "other-user", "Content-Type": "application/json" },
      body: JSON.stringify({ attachmentId: image.id }),
    })).status, 403);

    const { setAttachmentExternalAccessEnabled } = await import("../src/services/attachment-link-policy");
    setAttachmentExternalAccessEnabled(image.id, false);
    assert.equal((await app.request(shortRoute)).status, 403);
    assert.equal((await app.request(`${namedPath}${shareQuery}`)).status, 403);
    assert.equal((await createShare()).status, 403);
    // Disabling public links must not remove the owner's signed access.
    assert.equal((await app.request(`${namedPath}${signed.search}`)).status, 200);
    setAttachmentExternalAccessEnabled(image.id, true);

    const revoke = await app.request(`/attachments/file-share/${image.id}`, { method: "DELETE", headers: { "X-User-Id": OWNER_ID } });
    assert.equal(revoke.status, 200);
    assert.equal((await app.request(shortRoute)).status, 410);
    assert.equal((await app.request(`${namedPath}${shareQuery}`)).status, 410);
  } finally {
    if (previousOrigin === undefined) delete process.env.FILE_PUBLIC_ORIGIN;
    else process.env.FILE_PUBLIC_ORIGIN = previousOrigin;
  }
});
