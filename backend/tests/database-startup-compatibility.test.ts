import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";

const backendDirectory = path.resolve(__dirname, "..");

test("DCC-008: startup compatibility checks preserve newer data and allow older schemas", async () => {
  const { assertSchemaCompatibility, DatabaseUpgradeRequiredError } = await import("../src/db/schema-compatibility");
  const db = new Database(":memory:");
  try {
    assert.doesNotThrow(() => assertSchemaCompatibility(db, 131));
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master").get().count, 0);
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT); CREATE TABLE retained(content TEXT); INSERT INTO retained VALUES ('keep me');");
    for (const version of [40, 123, 131]) {
      db.prepare("INSERT OR REPLACE INTO schema_migrations VALUES (?, 'historical')").run(version);
      assert.doesNotThrow(() => assertSchemaCompatibility(db, 131));
    }
    assert.throws(() => assertSchemaCompatibility(db, 123), (error: any) => {
      assert.ok(error instanceof DatabaseUpgradeRequiredError);
      assert.equal(error.databaseSchemaVersion, 131);
      assert.equal(error.codeSchemaVersion, 123);
      return true;
    });
    assert.deepEqual(db.prepare("SELECT * FROM retained").all(), [{ content: "keep me" }]);
    assert.equal(db.prepare("SELECT max(version) AS version FROM schema_migrations").get().version, 131);
  } finally {
    db.close();
  }
});

function createFutureDatabase(directory: string): string {
  const filename = path.join(directory, "future.db");
  const db = new Database(filename);
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT); INSERT INTO schema_migrations VALUES (999999, 'future'); CREATE TABLE retained(content TEXT); INSERT INTO retained VALUES ('keep me');");
  db.close();
  return filename;
}

test("DCC-008: a newer database is rejected before baseline DDL or vacuum can modify it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-startup-test-"));
  try {
    const filename = createFutureDatabase(directory);
    const before = fs.readFileSync(filename);
    const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
      try {
        require('./src/db/schema').getDb();
        throw new Error('newer database unexpectedly opened');
      } catch (error) {
        if (error.code !== 'DATABASE_UPGRADE_REQUIRED') throw error;
      }
    `], { cwd: backendDirectory, env: { ...process.env, DB_PATH: filename }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(filename), before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startup check exits normally for a fresh database without creating it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-startup-test-"));
  try {
    const filename = path.join(directory, "new.db");
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/startup-check.ts"], {
      cwd: backendDirectory, env: { ...process.env, DB_PATH: filename }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(filename), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startup check accepts historical schema versions without rewriting their databases", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-startup-test-"));
  try {
    for (const version of [0, 40, 123, 131]) {
      const filename = path.join(directory, `legacy-${version}.db`);
      const db = new Database(filename);
      if (version) db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT); INSERT INTO schema_migrations VALUES (${version}, 'historical');`);
      else db.exec("CREATE TABLE retained(content TEXT)");
      db.close();
      const before = fs.readFileSync(filename);
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/startup-check.ts"], {
        cwd: backendDirectory, env: { ...process.env, DB_PATH: filename }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readFileSync(filename), before);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("unrelated startup failures are not disguised as upgrade prompts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-startup-test-"));
  try {
    const filename = path.join(directory, "corrupt.db");
    fs.writeFileSync(filename, "not a SQLite database");
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/startup-check.ts"], {
      cwd: backendDirectory, env: { ...process.env, DB_PATH: filename }, encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes("Upgrade prompt"));
    assert.equal(fs.readFileSync(filename, "utf8"), "not a SQLite database");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("DCC-008: incompatible startup serves an upgrade prompt but never a healthy or writable app", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-startup-test-"));
  const filename = createFutureDatabase(directory);
  const before = fs.readFileSync(filename);
  const child = spawn(process.execPath, ["--import", "tsx", "src/startup-check.ts", "--serve"], {
    cwd: backendDirectory,
    env: { ...process.env, DB_PATH: filename, PORT: "0", NOWEN_APP_VERSION: "1.5.1", JWT_SECRET: "never-expose-this-secret" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); });
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let output = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup prompt timed out: ${output}`)), 10_000);
    child.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
    const receive = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/Upgrade prompt listening on port (\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
  });
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(base);
  assert.equal(page.status, 503);
  const html = await page.text();
  assert.match(html, /请升级服务端/);
  assert.match(html, /1\.5\.1/);
  assert.ok(!html.includes(filename));
  assert.ok(!html.includes("never-expose-this-secret"));
  assert.equal(page.headers.get("cache-control"), "no-store");
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 503);
  assert.equal((await health.json()).code, "DATABASE_UPGRADE_REQUIRED");
  const version = await (await fetch(`${base}/api/version`)).json();
  assert.equal(version.appVersion, "1.5.1");
  assert.equal(version.schemaVersion, 999999);
  assert.ok(version.codeSchemaVersion < version.schemaVersion);
  assert.equal((await fetch(`${base}/api/notes`, { method: "POST", body: "{}" })).status, 503);
  assert.equal((await fetch(`${base}/api/version`, { method: "POST" })).status, 503);
  assert.equal(child.exitCode, null, "the prompt must stay up instead of triggering a restart loop");
  assert.deepEqual(fs.readFileSync(filename), before);
});
