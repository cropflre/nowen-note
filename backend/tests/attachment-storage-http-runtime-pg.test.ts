import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createAttachmentStorageRuntime } from "../src/services/attachment-storage-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

test("PostgreSQL attachment storage runtime writes and reads local HTTP objects safely", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nowen-pg-att-http-"));
  try {
    await initPgSchema(pool);
    await pool.query(`DELETE FROM system_settings WHERE key = 'attachmentStorage:config'`);
    const storage = createAttachmentStorageRuntime(new PostgresAdapter(pool), { dataDir });
    const body = Buffer.from("nowen-pg-attachment-body");
    await storage.writeObject("2026/08/test.bin", body, "application/octet-stream");
    assert.deepEqual(await storage.readObject("2026/08/test.bin"), body);
    assert.equal((await storage.checkExists("2026/08/test.bin")).exists, true);
    await storage.deleteObject("2026/08/test.bin");
    assert.equal(await storage.readObject("2026/08/test.bin"), null);
    assert.equal((await storage.checkExists("2026/08/test.bin")).exists, false);
    await assert.rejects(() => storage.writeObject("../escape.bin", body), /安全|越过|path/i);
  } finally {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
    await closePgPool(pool);
  }
});
