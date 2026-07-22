import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertSafeTestDatabasePath } from "../src/db/test-db-guard";

test("backend test processes use a database inside the system temporary directory", async () => {
  const { getDbPath } = await import("../src/db/schema");
  const resolved = path.resolve(getDbPath());
  const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), resolved);
});

test("test mode rejects the default development database path", () => {
  assert.throws(
    () => assertSafeTestDatabasePath(path.join(process.cwd(), "data", "nowen-note.db")),
    /Refusing to open a test database outside the system temporary directory/,
  );
});
