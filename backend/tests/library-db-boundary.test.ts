import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relativePath), "utf8");
}

const apiTokensSource = read("../src/lib/api-tokens.ts");
const attachmentRefsSource = read("../src/lib/attachmentRefs.ts");
const noteLinksSource = read("../src/lib/noteLinks.ts");
const schemaRepositorySource = read("../src/repositories/apiTokenSchemaRepository.ts");

test("API token library delegates driver-level schema initialization to a repository", () => {
  assert.doesNotMatch(apiTokensSource, /better-sqlite3/);
  assert.doesNotMatch(apiTokensSource, /\.exec\s*\(/);
  assert.match(apiTokensSource, /apiTokenSchemaRepository\.initialize\(db\)/);
  assert.match(schemaRepositorySource, /CREATE TABLE IF NOT EXISTS api_tokens/);
  assert.match(schemaRepositorySource, /CREATE TABLE IF NOT EXISTS api_token_usage/);
});

test("reference libraries do not import the SQLite driver only for compatibility parameters", () => {
  assert.doesNotMatch(attachmentRefsSource, /better-sqlite3/);
  assert.doesNotMatch(noteLinksSource, /better-sqlite3/);
  assert.match(attachmentRefsSource, /_db:\s*unknown/);
  assert.match(noteLinksSource, /_db:\s*unknown/);
});
