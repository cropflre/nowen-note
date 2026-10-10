// Run against the final production dependencies, without opening the user's database.
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const path = require("node:path");

const backend = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const requireBackend = createRequire(path.join(backend, "package.json"));
const Database = requireBackend("better-sqlite3");
const sqliteVec = requireBackend("sqlite-vec");
const { version } = requireBackend(path.join(path.dirname(requireBackend.resolve("sqlite-vec")), "package.json"));
const db = new Database(":memory:");
try {
  try {
    sqliteVec.load(db);
  } catch (error) {
    if (process.platform !== "linux") throw error;
    // SQLite's final .so.so error can hide the initial missing libc symbol.
    try {
      db.loadExtension(sqliteVec.getLoadablePath().replace(/\.so$/, ""));
    } catch (cause) {
      throw new Error(`${error.message}; loader retry without suffix: ${cause.message}`);
    }
  }
  assert.equal(db.prepare("SELECT vec_version() AS version").get().version, `v${version}`);
  db.exec("CREATE VIRTUAL TABLE smoke_vectors USING vec0(embedding float[2])");
  const insert = db.prepare("INSERT INTO smoke_vectors(rowid, embedding) VALUES (?, ?)");
  insert.run(1n, "[1,0]");
  insert.run(2n, "[0,1]");
  const hit = db.prepare(`SELECT rowid, distance FROM smoke_vectors
    WHERE embedding MATCH ? AND k = 1 ORDER BY distance`).get("[1,0]");
  assert.equal(hit.rowid, 1);
  assert.equal(hit.distance, 0);
  console.log(`[sqlite-vec-smoke] v${version}: extension load, vec0 and KNN passed (${process.arch})`);
} finally {
  db.close();
}
