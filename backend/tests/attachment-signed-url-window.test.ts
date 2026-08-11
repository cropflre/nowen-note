import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-attachment-signature-window-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.ATTACHMENT_SIGNING_SECRET = "test-attachment-window-secret-2026";

const OWNER_ID = "signature-window-owner";
const NOTEBOOK_ID = "signature-window-notebook";
const NOTE_ID = "signature-window-note";
const ATTACHMENT_ID = "signature-window-attachment";
const WINDOW_MS = 15 * 60 * 1000;

let getDb: () => Database.Database;
let closeDb: () => void;
let signedUrlModule: typeof import("../src/lib/attachment-signed-url");
let scope = "";

function withNow<T>(nowMs: number, action: () => T): T {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return action();
  } finally {
    Date.now = originalNow;
  }
}

test.before(async () => {
  const [schemaModule, module] = await Promise.all([
    import("../src/db/schema"),
    import("../src/lib/attachment-signed-url"),
  ]);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  signedUrlModule = module;

  const database = getDb();
  database
    .prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(OWNER_ID, OWNER_ID, "hash");
  database
    .prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(NOTEBOOK_ID, OWNER_ID, "Signature window");
  database
    .prepare(
      `INSERT INTO notes (id, userId, notebookId, title, content, contentText)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(NOTE_ID, OWNER_ID, NOTEBOOK_ID, "Signature window", "{}", "Signature window");
  database
    .prepare(
      `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ATTACHMENT_ID, NOTE_ID, OWNER_ID, "window.txt", "text/plain", 1, "window.txt");

  scope = signedUrlModule.createUserAttachmentScope(OWNER_ID, NOTE_ID);
});

test.after(() => {
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
  }
});

test("repeated signing inside one quantization window returns an identical cache key", () => {
  const base = Date.UTC(2026, 7, 6, 1, 1, 0);
  const ttl = 60_000;
  const first = withNow(base, () => signedUrlModule.createAttachmentSignedUrl(
    `/api/attachments/${ATTACHMENT_ID}`,
    ATTACHMENT_ID,
    scope,
    ttl,
  ));
  const second = withNow(base + 30_000, () => signedUrlModule.createAttachmentSignedUrl(
    `/api/attachments/${ATTACHMENT_ID}`,
    ATTACHMENT_ID,
    scope,
    ttl,
  ));

  assert.equal(second, first);
});

test("crossing a quantization window rotates exp, signature and URL", () => {
  const base = Date.UTC(2026, 7, 6, 1, 1, 0);
  const ttl = 60_000;
  const first = withNow(base, () => signedUrlModule.createAttachmentSignedParams(
    ATTACHMENT_ID,
    scope,
    ttl,
  ));
  const second = withNow(base + WINDOW_MS, () => signedUrlModule.createAttachmentSignedParams(
    ATTACHMENT_ID,
    scope,
    ttl,
  ));

  assert.notEqual(second.exp, first.exp);
  assert.notEqual(second.sig, first.sig);
});

test("quantization never expires earlier than the requested TTL", () => {
  const now = Date.UTC(2026, 7, 6, 1, 7, 23, 456);
  const ttl = 73_000;
  const params = withNow(now, () => signedUrlModule.createAttachmentSignedParams(
    ATTACHMENT_ID,
    scope,
    ttl,
  ));
  const expiryMs = Number(params.exp) * 1000;

  assert.ok(expiryMs >= now + ttl);
  assert.ok(expiryMs < now + ttl + WINDOW_MS);
});

test("a freshly issued maximum-TTL signature remains valid after quantization", () => {
  const now = Date.UTC(2026, 7, 6, 2, 3, 0);
  const params = withNow(now, () => signedUrlModule.createAttachmentSignedParams(
    ATTACHMENT_ID,
    scope,
    signedUrlModule.SIGNATURE_MAX_TTL_MS,
  ));
  const result = withNow(now, () => signedUrlModule.verifyAttachmentSignature(
    ATTACHMENT_ID,
    params.exp,
    params.sig,
    params.scope,
  ));

  assert.equal(result.valid, true);
  assert.equal(result.accessKind, "user");
});

test("timestamps beyond max TTL plus quantization tolerance are rejected first", () => {
  const now = Date.UTC(2026, 7, 6, 2, 3, 0);
  const tooLongExp = Math.floor(
    (now + signedUrlModule.SIGNATURE_MAX_TTL_MS + WINDOW_MS + 1_000) / 1000,
  ).toString();
  const result = withNow(now, () => signedUrlModule.verifyAttachmentSignature(
    ATTACHMENT_ID,
    tooLongExp,
    "00".repeat(32),
    scope,
  ));

  assert.equal(result.valid, false);
  assert.equal(result.reason, "exp_too_long");
});

test("scope changes always produce a different signature in the same window", () => {
  const now = Date.UTC(2026, 7, 6, 4, 5, 0);
  const readScope = signedUrlModule.createUserAttachmentScope(OWNER_ID, NOTE_ID, true);
  const previewOnlyScope = signedUrlModule.createUserAttachmentScope(OWNER_ID, NOTE_ID, false);
  const readParams = withNow(now, () => signedUrlModule.createAttachmentSignedParams(
    ATTACHMENT_ID,
    readScope,
  ));
  const previewParams = withNow(now, () => signedUrlModule.createAttachmentSignedParams(
    ATTACHMENT_ID,
    previewOnlyScope,
  ));

  assert.equal(readParams.exp, previewParams.exp);
  assert.notEqual(readParams.scope, previewParams.scope);
  assert.notEqual(readParams.sig, previewParams.sig);
});
