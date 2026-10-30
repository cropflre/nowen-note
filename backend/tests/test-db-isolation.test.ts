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

test("Node test runner context rejects development databases even without NODE_ENV=test", () => {
  const environment=process.env.NODE_ENV, context=process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_ENV;
    process.env.NODE_TEST_CONTEXT="child-v8";
    assert.throws(()=>assertSafeTestDatabasePath(path.join(process.cwd(),"data","nowen-note.db")),/Refusing to open a test database/);
    assert.doesNotThrow(()=>assertSafeTestDatabasePath(path.join(os.tmpdir(),"nowen-isolation-fixture","test.db")));
  } finally {
    if(environment===undefined) delete process.env.NODE_ENV;else process.env.NODE_ENV=environment;
    if(context===undefined) delete process.env.NODE_TEST_CONTEXT;else process.env.NODE_TEST_CONTEXT=context;
  }
});
