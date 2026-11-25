import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

test("Sync V2 binary HTTP uses valid framing and preserves every attachment byte", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sync-blob-http-"));
  Object.assign(process.env, { NODE_ENV: "test", DB_PATH: path.join(directory, "server.db"), ELECTRON_USER_DATA: directory, NOWEN_LOCAL_FIRST_SYNC_V2: "1" });
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  const schema = await import("../src/db/schema");
  const storage = await import("../src/services/attachment-storage");
  const db = schema.getDb(), bytes = randomBytes(16 * 1024), hash = createHash("sha256").update(bytes).digest("hex");
  db.prepare("INSERT INTO users(id,username,passwordHash) VALUES ('blob-http-user','blob-http-user','fixture')").run();
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES ('blob-http-book','blob-http-user','Fixture')").run();
  db.prepare("INSERT INTO notes(id,userId,notebookId,title,content) VALUES ('blob-http-note','blob-http-user','blob-http-book','Fixture','body')").run();
  db.prepare("INSERT INTO attachments(id,noteId,userId,filename,mimeType,size,path,hash) VALUES ('blob-http-asset','blob-http-note','blob-http-user','fixture.bin','application/octet-stream',?,'fixture/asset.bin',?)").run(bytes.length, hash);
  await storage.writeAttachmentObject("fixture/asset.bin", bytes);
  const app = new Hono();
  app.use("*", async (c, next) => { c.req.raw.headers.set("X-User-Id", c.req.header("Authorization") === "Bearer fixture-user" ? "blob-http-user" : "other-user"); await next(); });
  app.route("/api/sync/v2/blob", (await import("../src/routes/sync-v2-blob")).default);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/sync/v2/blob/blob-http-asset?scopeKey=personal`;
  try {
    await new Promise<void>((resolve, reject) => {
      http.get(url, { headers: { Authorization: "Bearer fixture-user" } }, (response) => {
        try {
          assert.equal(response.statusCode, 200);
          assert.ok(response.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "content-length").length <= 1);
          if (response.headers["content-length"]) assert.equal(response.headers["content-length"], String(bytes.length));
          else assert.equal(response.headers["transfer-encoding"], "chunked");
          assert.equal(response.headers["x-blob-hash"], hash);
          let size = 0; const digest = createHash("sha256");
          response.on("data", (chunk) => { size += chunk.length; digest.update(chunk); });
          response.on("error", reject);
          response.on("end", () => { try { assert.equal(size, bytes.length); assert.equal(digest.digest("hex"), hash); resolve(); } catch (error) { reject(error); } });
        } catch (error) { response.resume(); reject(error); }
      }).on("error", reject);
    });
    const head = await fetch(url, { method: "HEAD", headers: { Authorization: "Bearer fixture-user" } });
    assert.equal(head.status, 200); assert.equal(head.headers.get("x-blob-size"), String(bytes.length)); assert.equal(head.headers.get("x-blob-hash"), hash);
    assert.equal((await fetch(url, { headers: { Authorization: "Bearer other-user" } })).status, 404);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); schema.closeDb(); fs.rmSync(directory, { recursive: true, force: true }); }
});
