// Private loopback test fixture: never use the user's database or credentials.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-encrypted-browser-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-only-encrypted-browser-fixture-secret";

async function start() {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('fixture-owner', 'fixture-owner', 'test-hash')").run();
  db.prepare("INSERT INTO notebooks (id, name, userId) VALUES ('fixture-public-book', 'Public notebook', 'fixture-owner')").run();
  const { initAuditTables } = await import("../src/services/audit.js"); initAuditTables();
  const { default: notes } = await import("../src/routes/notes.js");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Access-Control-Allow-Origin", "http://127.0.0.1:5176");
    c.header("Access-Control-Allow-Headers", "Authorization,Content-Type,Accept");
    c.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    c.req.raw.headers.set("X-User-Id", "fixture-owner");
    await next();
  });
  app.get("/api/health", (c) => c.json({ fixture: true }));
  app.route("/api/notes", notes);
  app.get("/api/fixture/scan", (c) => {
    const forbidden = ["PRIVATE_ENCRYPTED_M2_SENTINEL", "test-only-m2-password", "PRIVATE_ENCRYPTED_M3_SENTINEL", "test-only-m3-password"];
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const leaks: string[] = [];
    for (const { name } of tables) {
      if (name.startsWith("sqlite_")) continue;
      const rows = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all();
      if (forbidden.some((marker) => JSON.stringify(rows).includes(marker))) leaks.push(name);
    }
    for (const file of fs.readdirSync(directory)) {
      if (fs.statSync(path.join(directory, file)).isFile() && forbidden.some((marker) => fs.readFileSync(path.join(directory, file)).includes(marker))) leaks.push(file);
    }
    return c.json({ leaks });
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 5177 });
  const shutdown = () => { server.close(() => { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); process.exit(0); }); };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
}
void start().catch((error) => { console.error(error); fs.rmSync(directory, { recursive: true, force: true }); process.exit(1); });
