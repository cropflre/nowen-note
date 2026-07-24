import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DatabaseAdapter } from "../src/db/adapters/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-block-authority-repository-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("block authority repository queries document, records and bounded operations through DatabaseAdapter", async () => {
  const calls: Array<{ kind: "one" | "many"; sql: string; params: unknown[] }> = [];
  const adapter: DatabaseAdapter = {
    async queryOne<T>(sql: string, params: unknown[] = []) {
      calls.push({ kind: "one", sql, params });
      return { noteId: "repo-note", status: "healthy" } as T;
    },
    async queryMany<T>(sql: string, params: unknown[] = []) {
      calls.push({ kind: "many", sql, params });
      if (sql.includes("note_block_records")) return [{ noteId: "repo-note", blockId: "blk_repo" }] as T[];
      return [{ noteId: "repo-note", operationType: "whole-save" }] as T[];
    },
    async execute() { throw new Error("只读 repository 不应写入"); },
    async executeBatch() { throw new Error("只读 repository 不应批量写入"); },
    async executeStatements() { throw new Error("只读 repository 不应执行事务写入"); },
  };
  const { createBlockAuthorityRepository } = await import("../src/repositories/blockAuthorityRepository");
  const repositoryIndexSource = fs.readFileSync(
    new URL("../src/repositories/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(repositoryIndexSource, /blockAuthorityRepository[\s\S]*createBlockAuthorityRepository/);
  const repository = createBlockAuthorityRepository(adapter);

  assert.equal((await repository.getDocument("repo-note"))?.noteId, "repo-note");
  assert.equal((await repository.listRecords("repo-note"))[0]?.blockId, "blk_repo");
  assert.equal((await repository.listOperations("repo-note", { limit: 999, offset: 3 }))[0]?.operationType, "whole-save");

  assert.deepEqual(calls.map((call) => call.params), [
    ["repo-note"],
    ["repo-note"],
    ["repo-note", 100, 3],
  ]);
  for (const call of calls) {
    assert.match(call.sql, /\?/);
    assert.doesNotMatch(call.sql, /\$\d+/);
  }
});
