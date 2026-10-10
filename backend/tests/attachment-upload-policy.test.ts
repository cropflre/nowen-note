import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

const originalLimit = process.env.MAX_ATTACHMENT_SIZE_MB;

let HonoWithPolicy: typeof Hono;

test.before(async () => {
  await import("../src/runtime/attachment-upload-policy");
  HonoWithPolicy = Hono;
});

test.after(() => {
  if (originalLimit === undefined) delete process.env.MAX_ATTACHMENT_SIZE_MB;
  else process.env.MAX_ATTACHMENT_SIZE_MB = originalLimit;
});

function createApp() {
  const app = new HonoWithPolicy();
  const attachments = new HonoWithPolicy();
  attachments.post("/", (c) => c.json({ error: "文件过大（legacy）" }, 413));
  app.route("/api/attachments", attachments);
  return app;
}

test("policy endpoint exposes the effective configured attachment limit", async () => {
  process.env.MAX_ATTACHMENT_SIZE_MB = "500";
  const app = createApp();
  const response = await app.request("/api/attachment-upload-policy");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const payload = await response.json() as {
    maxAttachmentSizeBytes: number;
    maxAttachmentSizeMiB: number;
  };
  assert.equal(payload.maxAttachmentSizeBytes, 500 * 1024 * 1024);
  assert.equal(payload.maxAttachmentSizeMiB, 500);
});

test("invalid configuration falls back to the same 100 MiB contract as attachments-core", async () => {
  process.env.MAX_ATTACHMENT_SIZE_MB = "not-a-number";
  const app = createApp();
  const response = await app.request("/api/attachment-upload-policy");
  const payload = await response.json() as { maxAttachmentSizeBytes: number };
  assert.equal(payload.maxAttachmentSizeBytes, 100 * 1024 * 1024);
});

test("legacy 413 is normalized with machine-readable max and actual bytes", async () => {
  process.env.MAX_ATTACHMENT_SIZE_MB = "100";
  const app = createApp();
  const actualSizeBytes = 100 * 1024 * 1024 + 1;
  const response = await app.request(`/api/attachments?__uploadSize=${actualSizeBytes}`, {
    method: "POST",
  });
  assert.equal(response.status, 413);
  const payload = await response.json() as {
    code: string;
    maxSizeBytes: number;
    actualSizeBytes: number;
    error: string;
  };
  assert.equal(payload.code, "ATTACHMENT_TOO_LARGE");
  assert.equal(payload.maxSizeBytes, 100 * 1024 * 1024);
  assert.equal(payload.actualSizeBytes, actualSizeBytes);
  assert.match(payload.error, /100 MiB/);
});
