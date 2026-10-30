import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-assets-scale-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;
let app: Hono;
let schema: typeof import("../src/db/schema");
test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  schema = await import("../src/db/schema");
  const { default: files } = await import("../src/routes/files");
  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree");
  app = new Hono().route("/api/files", wrapKnowledgeRoute("/api/files", files));
  const db = schema.getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('scale-user', 'scale-user', 'hash')").run();
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('scale-book', 'scale-user', 'Scale')").run();
  db.prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES ('scale-holder', 'scale-user', 'scale-book', 'Scale', '{}')").run();
});
test.after(() => { schema?.closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });
let seeded = 0;
for (const count of [100, 1000, 10000]) test(`scoped pagination/search with ${count} metadata rows`, async () => {
  const db = schema.getDb();
  const insert = db.prepare(`INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, uploadSource)
    VALUES (?, 'scale-holder', 'scale-user', ?, 'text/plain', 16, ?, 'file_manager')`);
  db.transaction(() => { for (; seeded < count; seeded++) {
    const name = `file-${String(seeded).padStart(5, "0")}`;
    insert.run(name, `${name}.txt`, `${name}.txt`);
  } })();
  const query = async (url: string) => {
    const start = performance.now();
    const response = await app.request(url, { headers: { "X-User-Id": "scale-user" } });
    assert.equal(response.status, 200);
    return { payload: await response.json() as any, elapsed: performance.now() - start };
  };
  const cold = await query("/api/files?page=2&pageSize=60&sort=name_asc");
  const warm = await query("/api/files?page=2&pageSize=60&sort=name_asc");
  assert.equal(cold.payload.total, count);
  assert.equal(cold.payload.items.length, Math.min(60, count - 60));
  assert.equal(cold.payload.items[0].id, "file-00060");
  assert.deepEqual(warm.payload.items.map((item: any) => item.id), cold.payload.items.map((item: any) => item.id));
  const search = await query("/api/files?fileKind=document&q=file-00042&pageSize=60");
  assert.equal(search.payload.total, 1);
  console.log(`[assets-scale] rows=${count} first-query=${cold.elapsed.toFixed(1)}ms warm=${warm.elapsed.toFixed(1)}ms search=${search.elapsed.toFixed(1)}ms; metadata-only fixtures, ${process.platform}/Node ${process.versions.node} ABI ${process.versions.modules}`);
});
