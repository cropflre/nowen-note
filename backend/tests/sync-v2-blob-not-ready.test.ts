import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import sharp from "sharp";

// Signed attachment URLs are created by the routes; configure them before those modules load.
process.env.ATTACHMENT_LEGACY_PUBLIC_URL = "false";
process.env.ATTACHMENT_SIGNING_SECRET = "sync-blob-not-ready-secret";

const OWNER = "android-image-owner";
const NOTEBOOK = "android-image-book";
let app: Hono;
let jpeg: Buffer;
let schema: typeof import("../src/db/schema");
let storage: typeof import("../src/services/attachment-storage");
let blob: typeof import("../src/sync/blob");
let signed: typeof import("../src/lib/attachment-signed-url");
let sync: typeof import("../src/sync/apply");

const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const blobUrl = (id: string) => `/api/sync/v2/blob/${id}?scopeKey=personal`;

test.before(async () => {
  schema = await import("../src/db/schema");
  storage = await import("../src/services/attachment-storage");
  blob = await import("../src/sync/blob");
  signed = await import("../src/lib/attachment-signed-url");
  sync = await import("../src/sync/apply");
  const routes = await import("../src/routes/attachments");
  const blobRoutes = (await import("../src/routes/sync-v2-blob")).default;
  jpeg = await sharp({ create: { width: 48, height: 32, channels: 3, background: "#4a6fa5" } }).jpeg().toBuffer();

  // Every deployment has the attachments root; an empty relative path resolves to it.
  storage.ensureAttachmentsDir();
  const db = schema.getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(OWNER, OWNER);
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, 'Android')").run(NOTEBOOK, OWNER);

  app = new Hono();
  // Production mounts Sync V2 behind JWT, which injects the verified user id.
  app.use("/api/sync/v2/*", async (c, next) => {
    c.req.raw.headers.set("X-User-Id", OWNER);
    await next();
  });
  app.route("/api/sync/v2/blob", blobRoutes);
  app.get("/api/attachments/:id", routes.handleDownloadAttachment);
});

test.after(() => schema?.closeDb());

/** Android pushes attachment metadata first; the server row has no bytes until the blob PUT. */
function syncAndroidImageMetadata(bytes: Buffer): { id: string; noteId: string } {
  const db = schema.getDb();
  const noteId = crypto.randomUUID();
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, ?, 'test', '{}')")
    .run(noteId, OWNER, NOTEBOOK);
  sync.applyMutation(db, {
    userId: OWNER,
    deviceId: "android-device",
    mutationId: crypto.randomUUID(),
    entityType: "attachment",
    entityId: id,
    operation: "upsert",
    workspaceId: null,
    payload: { id, noteId, filename: "1000028171.jpg", mimeType: "image/jpeg", size: bytes.length, hash: sha256(bytes) },
  });
  return { id, noteId };
}

function storedPath(id: string): string {
  return (schema.getDb().prepare("SELECT path FROM attachments WHERE id = ?").get(id) as { path: string }).path;
}

function signedAttachmentUrl(id: string, noteId: string, extra: Record<string, string> = {}): string {
  const url = new URL(signed.createUserAttachmentAccessUrls(OWNER, [{ id, noteId }])[id], "http://localhost");
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url.pathname + url.search;
}

async function withoutEisdirWarnings<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((value) => String(value instanceof Error ? `${value.message} ${(value as NodeJS.ErrnoException).code}` : value)).join(" "));
  };
  try {
    return { result: await run(), warnings: warnings.filter((line) => line.includes("EISDIR")) };
  } finally {
    console.warn = original;
  }
}

test("DCC-003: HEAD reports metadata-only bytes as missing so desktop and NAS clients upload them", async () => {
  const { id } = syncAndroidImageMetadata(jpeg);
  assert.equal(storedPath(id), "", "precondition: metadata synced, bytes not uploaded");

  // Hono dispatches HEAD to the GET handler; the designed probe answer is 404, not GET's 409.
  assert.equal((await app.request(blobUrl(id), { method: "HEAD" })).status, 404);

  // What Capacitor's native fetch patch sends for a Blob body: rejected, never stored.
  const corrupt = await app.request(blobUrl(id), { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: "{}" });
  assert.equal(corrupt.status, 409);
  assert.equal(((await corrupt.json()) as { code: string }).code, "CHECKSUM_MISMATCH");
  assert.equal(storedPath(id), "", "a checksum failure must not create a stored object");

  const client = new blob.SyncBlobClient({
    serverUrl: "http://sync.test",
    credential: { serverUrl: "http://sync.test", token: "desktop-token" },
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) => app.request(String(input), init)) as typeof fetch,
  });
  assert.equal(await client.exists(id), false);
  await client.upload(id, jpeg, "image/jpeg");
  assert.equal((await app.request(blobUrl(id), { method: "HEAD" })).status, 200);
  assert.equal(await client.exists(id), true);
  assert.deepEqual(await storage.readAttachmentObject(storedPath(id)), jpeg);
});

test("DCC-007: attachment reads before the bytes arrive return BLOB_NOT_READY instead of EISDIR or 500", async () => {
  const { id, noteId } = syncAndroidImageMetadata(jpeg);
  const variants = [{}, { w: "320" }, { media: "info" }];

  const { result: pending, warnings } = await withoutEisdirWarnings(() => Promise.all(
    variants.map(async (extra) => {
      const response = await app.request(signedAttachmentUrl(id, noteId, extra));
      return { status: response.status, body: await response.json().catch(() => null) as { code?: string } | null };
    }),
  ));
  assert.deepEqual(warnings, []);
  for (const response of pending) {
    assert.equal(response.status, 409);
    assert.equal(response.body?.code, "ATTACHMENT_BLOB_NOT_READY");
  }

  // Recovery needs no server repair: once the device uploads the bytes, the same URLs work.
  const put = await app.request(blobUrl(id), { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: jpeg });
  assert.equal(put.status, 200, await put.clone().text());
  const original = await app.request(signedAttachmentUrl(id, noteId));
  assert.equal(original.status, 200);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), jpeg);
  assert.equal((await app.request(signedAttachmentUrl(id, noteId, { w: "320" }))).status, 200);
  const info = await app.request(signedAttachmentUrl(id, noteId, { media: "info" }));
  assert.equal(info.status, 200);
  assert.equal(((await info.json()) as { mimeType: string }).mimeType, "image/jpeg");
});

test("a storage path that resolves to a directory is reported as a missing file, not EISDIR", async () => {
  const { id, noteId } = syncAndroidImageMetadata(jpeg);
  const directory = "2026/11";
  fs.mkdirSync(path.join(storage.getAttachmentsDir(), directory), { recursive: true });
  schema.getDb().prepare("UPDATE attachments SET path = ? WHERE id = ?").run(directory, id);

  const { result, warnings } = await withoutEisdirWarnings(async () => ({
    original: await app.request(signedAttachmentUrl(id, noteId)),
    info: await app.request(signedAttachmentUrl(id, noteId, { media: "info" })),
    head: await app.request(blobUrl(id), { method: "HEAD" }),
    get: await app.request(blobUrl(id)),
  }));
  assert.deepEqual(warnings, []);
  assert.equal(result.original.status, 404);
  assert.equal(((await result.original.json()) as { error: string }).error, "attachment file missing");
  assert.equal(result.info.status, 404);
  assert.equal(result.head.status, 404);
  assert.equal(result.get.status, 409);
  assert.equal(((await result.get.json()) as { code: string }).code, "BLOB_NOT_READY");
  assert.equal(await storage.readAttachmentObject(directory), null);
  assert.equal(await storage.readAttachmentObject(""), null);
});
