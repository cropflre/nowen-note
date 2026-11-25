import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import "./setup-db-isolation";
import { closeDb } from "../src/db/schema";
import { getLocalAttachmentPath, writeAttachmentObjectFromFile } from "../src/services/attachment-storage";

test.after(() => closeDb());

test("file attachment writes retain bytes without whole-file Buffers for local and signed S3 drivers", async () => {
  const directory = process.env.ELECTRON_USER_DATA!;
  const source = path.join(directory, "stream-input.pdf");
  const body = crypto.randomBytes(1024 * 1024);
  fs.writeFileSync(source, body);
  delete process.env.ATTACHMENT_STORAGE;
  await writeAttachmentObjectFromFile("2026/10/local.pdf", source, "application/pdf");
  assert.deepEqual(fs.readFileSync(getLocalAttachmentPath("2026/10/local.pdf")), body);
  await assert.rejects(writeAttachmentObjectFromFile("../escape.pdf", source), /Invalid attachment storage key/);
  const link = path.join(directory, "link.pdf");
  fs.symlinkSync(source, link);
  await assert.rejects(writeAttachmentObjectFromFile("2026/10/link.pdf", link), /regular file/);

  const originalFetch = globalThis.fetch;
  const previousEnv = Object.fromEntries(["ATTACHMENT_STORAGE", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { ATTACHMENT_STORAGE: "s3", S3_ENDPOINT: "https://storage.invalid", S3_BUCKET: "fixture", S3_ACCESS_KEY_ID: "test-key", S3_SECRET_ACCESS_KEY: "test-secret" });
  let uploads = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://storage.invalid/fixture/2026/10/remote.pdf");
    assert.equal(init?.method, "PUT");
    assert.ok(init?.body && !Buffer.isBuffer(init.body));
    assert.equal((init as RequestInit & { duplex: string }).duplex, "half");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("content-length"), String(body.length));
    assert.equal(headers.get("x-amz-content-sha256"), crypto.createHash("sha256").update(body).digest("hex"));
    const digest = crypto.createHash("sha256");
    for await (const chunk of init!.body as unknown as AsyncIterable<Buffer>) digest.update(chunk);
    assert.equal(digest.digest("hex"), headers.get("x-amz-content-sha256"));
    uploads++;
    return new Response(null, { status: 200 });
  };
  try { await writeAttachmentObjectFromFile("2026/10/remote.pdf", source, "application/pdf"); assert.equal(uploads, 1); }
  finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
