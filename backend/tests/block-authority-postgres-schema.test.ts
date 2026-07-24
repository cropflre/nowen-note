import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(
  path.join(testDir, "../src/db/postgres/schema.base.sql"),
  "utf8",
);

test("PostgreSQL Block 权威表保留跨适配器一致的原始字符串载荷", () => {
  const authoritySchema = schema.slice(
    schema.indexOf("CREATE TABLE IF NOT EXISTS note_block_documents"),
    schema.indexOf("-- Experimental Y.js section subdocuments"),
  );

  assert.match(authoritySchema, /"rootOrderJson"\s+TEXT\s+NOT NULL\s+DEFAULT '\[\]'/);
  assert.match(authoritySchema, /\bpayload\s+TEXT\s+NOT NULL/);
  assert.match(authoritySchema, /"operationJson"\s+TEXT\s+NOT NULL/);
  assert.doesNotMatch(authoritySchema, /(?:rootOrderJson|payload|operationJson)"?\s+JSONB/);
});
