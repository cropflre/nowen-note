import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-shared-attachment-access-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.ATTACHMENT_LEGACY_PUBLIC_URL = "false";
process.env.ATTACHMENT_SIGNING_SECRET = "test-attachment-signing-secret-216";

const OWNER_ID = "attachment-owner";
const RECIPIENT_ID = "attachment-recipient";
const STRANGER_ID = "attachment-stranger";
const NOTEBOOK_ID = "attachment-shared-notebook";
const NOTE_ID = "attachment-shared-note";
const SHARE_ID = "attachment-public-share";
const SHARE_TOKEN = "attachment-share-token";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let attachmentId = "";
let uploadAccessUrl = "";

function db() {
  return getDb();
}

function signedRoute(url: string): string {
  const parsed = new URL(url, "http://localhost");
  return `${parsed.pathname.replace(/^\/api/, "")}${parsed.search}`;
}

async function responseJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

test.before(async () => {
  const [attachmentsModule, filesModule, schemaModule] = await Promise.all([
    import("../src/routes/attachments"),
    import("../src/routes/files"),
    import("../src/db/schema"),
  ]);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  app = new Hono();
  app.get("/attachments/:id", attachmentsModule.handleDownloadAttachment);
  app.route("/attachments", attachmentsModule.default);
  app.route("/files", filesModule.default);

  const database = db();
  const insertUser = database.prepare(
    "INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)",
  );
  insertUser.run(OWNER_ID, OWNER_ID, "hash");
  insertUser.run(RECIPIENT_ID, RECIPIENT_ID, "hash");
  insertUser.run(STRANGER_ID, STRANGER_ID, "hash");

  database
    .prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(NOTEBOOK_ID, OWNER_ID, "Shared notebook");
  database
    .prepare(
      `INSERT INTO notes (id, userId, notebookId, title, content, contentText)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(NOTE_ID, OWNER_ID, NOTEBOOK_ID, "Shared note", "{}", "Shared note");
  database
    .prepare(
      `INSERT INTO notebook_members (id, notebookId, userId, role, status, invitedBy)
       VALUES (?, ?, ?, 'viewer', 'active', ?)`,
    )
    .run(`${NOTEBOOK_ID}:${RECIPIENT_ID}`, NOTEBOOK_ID, RECIPIENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO shares (id, noteId, ownerId, shareToken, shareType, permission)
       VALUES (?, ?, ?, ?, 'link', 'view')`,
    )
    .run(SHARE_ID, NOTE_ID, OWNER_ID, SHARE_TOKEN);

  const form = new FormData();
  form.set("noteId", NOTE_ID);
  form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "shared.pdf", {
    type: "application/pdf",
  }));
  const upload = await app.request("/attachments", {
    method: "POST",
    headers: { "X-User-Id": OWNER_ID },
    body: form,
  });
  assert.equal(upload.status, 201);
  const uploadPayload = await responseJson<{
    id: string;
    accessUrls?: Record<string, string>;
  }>(upload);
  attachmentId = uploadPayload.id;
  uploadAccessUrl = uploadPayload.accessUrls?.[attachmentId] || "";
  assert.ok(attachmentId);
});

test.after(() => {
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (error) {
    // tsx 在 Windows 下可能让同一测试依赖保留第二个 SQLite 模块实例，
    // 进程退出前主库仍被占用；清理竞争不应掩盖接口断言结果。
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
  }
});

test("specific-user notebook share receives a revocable attachment URL", async () => {
  const access = await app.request(`/attachments/access/urls?noteId=${NOTE_ID}`, {
    headers: { "X-User-Id": RECIPIENT_ID },
  });
  assert.equal(access.status, 200);
  assert.equal(access.headers.get("cache-control"), "private, no-store");

  const payload = await responseJson<{ urls: Record<string, string> }>(access);
  const signedUrl = payload.urls[attachmentId];
  assert.ok(signedUrl);
  assert.match(signedUrl, /[?&]exp=/);
  assert.match(signedUrl, /[?&]sig=/);
  assert.match(signedUrl, /[?&]scope=/);

  const beforeRemoval = await app.request(signedRoute(signedUrl));
  assert.equal(beforeRemoval.status, 200);
  assert.equal(beforeRemoval.headers.get("content-type"), "application/pdf");
  // no-cache（而非 no-store）：浏览器可留副本，但每次使用前必须回源复核授权。
  assert.equal(
    beforeRemoval.headers.get("cache-control"),
    "private, no-cache, must-revalidate, no-transform",
  );
  // 附件内容由 id 唯一确定，因此提供稳定 ETag 供条件请求复用。
  const contentEtag = beforeRemoval.headers.get("etag");
  assert.ok(contentEtag, "附件本体应带 ETag 以支持 304 复用");

  // 授权仍在时，条件请求应命中 304 且不重传实体。
  const revalidated = await app.request(signedRoute(signedUrl), {
    headers: { "If-None-Match": contentEtag as string },
  });
  assert.equal(revalidated.status, 304);
  assert.equal(await revalidated.text(), "", "304 不应携带响应体");

  db().prepare("DELETE FROM notebook_members WHERE notebookId = ? AND userId = ?")
    .run(NOTEBOOK_ID, RECIPIENT_ID);

  const afterRemoval = await app.request(signedRoute(signedUrl));
  assert.equal(afterRemoval.status, 403);
  const denied = await responseJson<{ code: string; reason: string }>(afterRemoval);
  assert.equal(denied.code, "ATTACHMENT_ACCESS_REVOKED");
  assert.equal(denied.reason, "user_access_revoked");

  // 关键：带着此前拿到的有效 ETag 再来，也必须被拒绝，不能因条件请求而回 304。
  // 否则允许本地副本就等于放宽了撤销的即时性。
  const revalidateAfterRemoval = await app.request(signedRoute(signedUrl), {
    headers: { "If-None-Match": contentEtag as string },
  });
  assert.equal(
    revalidateAfterRemoval.status,
    403,
    "授权撤销后条件请求必须同样被拒绝，不得返回 304",
  );
});

test("authenticated upload immediately returns a signed display URL", async () => {
  assert.ok(uploadAccessUrl);
  assert.match(uploadAccessUrl, /[?&]sig=/);

  const response = await app.request(signedRoute(uploadAccessUrl));
  assert.equal(response.status, 200);
});

test("file list returns signed display URLs for thumbnails and previews", async () => {
  const response = await app.request("/files", {
    headers: { "X-User-Id": OWNER_ID },
  });
  assert.equal(response.status, 200);

  const payload = await responseJson<{
    items: Array<{ id: string; url: string }>;
    accessUrls?: Record<string, string>;
  }>(response);
  assert.equal(payload.items.some((item) => item.id === attachmentId), true);
  assert.match(payload.accessUrls?.[attachmentId] || "", /[?&]sig=/);
});

test("note attachment list includes files owned by a blank source note", async () => {
  const response = await app.request(`/files?noteId=${NOTE_ID}`, {
    headers: { "X-User-Id": OWNER_ID },
  });
  assert.equal(response.status, 200);

  const payload = await responseJson<{
    items: Array<{ id: string }>;
    total: number;
  }>(response);
  assert.equal(payload.total, 1);
  assert.deepEqual(payload.items.map((item) => item.id), [attachmentId]);
});

test("unrelated users cannot exchange a guessed note id for attachment URLs", async () => {
  const response = await app.request(`/attachments/access/urls?noteId=${NOTE_ID}`, {
    headers: { "X-User-Id": STRANGER_ID },
  });
  assert.equal(response.status, 403);
  const payload = await responseJson<{ code: string }>(response);
  assert.equal(payload.code, "ATTACHMENT_ACCESS_DENIED");
});

test("public share attachment URLs stop working immediately after revoke", async () => {
  const access = await app.request(`/attachments/share-access?token=${SHARE_TOKEN}`);
  assert.equal(access.status, 200);
  const payload = await responseJson<{ urls: Record<string, string> }>(access);
  const signedUrl = payload.urls[attachmentId];
  assert.ok(signedUrl);

  const beforeRevoke = await app.request(signedRoute(signedUrl));
  assert.equal(beforeRevoke.status, 200);

  db().prepare("UPDATE shares SET isActive = 0 WHERE id = ?").run(SHARE_ID);

  const afterRevoke = await app.request(signedRoute(signedUrl));
  assert.equal(afterRevoke.status, 403);
  const denied = await responseJson<{ code: string; reason: string }>(afterRevoke);
  assert.equal(denied.code, "ATTACHMENT_ACCESS_REVOKED");
  assert.equal(denied.reason, "share_access_revoked");
});

test("signed URL creation preserves existing preview and download query parameters", async () => {
  const { createAttachmentSignedUrl, createUserAttachmentScope } = await import(
    "../src/lib/attachment-signed-url"
  );
  const signed = createAttachmentSignedUrl(
    `/api/attachments/${attachmentId}?download=1`,
    attachmentId,
    createUserAttachmentScope(OWNER_ID, NOTE_ID),
  );
  const parsed = new URL(signed, "http://localhost");
  assert.equal(parsed.searchParams.get("download"), "1");
  assert.ok(parsed.searchParams.get("exp"));
  assert.ok(parsed.searchParams.get("sig"));
  assert.ok(parsed.searchParams.get("scope"));
  assert.equal((signed.match(/\?/g) || []).length, 1);
});
