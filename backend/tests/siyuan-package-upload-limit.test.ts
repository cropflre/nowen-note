import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-siyuan-upload-limit-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.SIYUAN_IMPORT_MAX_BYTES = "4";

let app: Hono;
let closeDb: () => void;

test.before(async () => {
  const [exportModule, schemaModule] = await Promise.all([
    import("../src/routes/export"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/export", exportModule.default);
  closeDb = (schemaModule as { closeDb: () => void; getDb: () => Database.Database }).closeDb;
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

test("siyuan package import rejects oversized Content-Length before parsing multipart", async () => {
  const res = await app.request("/export/import/siyuan-package?workspaceId=personal", {
    method: "POST",
    headers: {
      "X-User-Id": "upload-limit-user",
      "Content-Type": "multipart/form-data; boundary=limit",
      "Content-Length": "5",
    },
    body: "--limit\r\n".repeat(2),
  });

  const text = await res.text();
  assert.equal(res.status, 413, text);
  const payload = JSON.parse(text) as { code?: string };
  assert.equal(payload.code, "SIYUAN_IMPORT_TOO_LARGE");
});

test("siyuan package import rejects multipart file streams over the upload limit", async () => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3, 4, 5])], "oversized.zip", { type: "application/zip" }));

  const res = await app.request("/export/import/siyuan-package?workspaceId=personal", {
    method: "POST",
    headers: { "X-User-Id": "upload-limit-user" },
    body: form,
  });

  const text = await res.text();
  assert.equal(res.status, 413, text);
  const payload = JSON.parse(text) as { code?: string };
  assert.equal(payload.code, "SIYUAN_IMPORT_TOO_LARGE");
});
