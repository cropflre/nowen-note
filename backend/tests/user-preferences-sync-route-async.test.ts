import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const routeSource = fs.readFileSync(
  path.resolve(__dirname, "../src/routes/user-preferences-sync.ts"),
  "utf8",
);

const repositorySource = fs.readFileSync(
  path.resolve(__dirname, "../src/repositories/userPreferencesSyncRepository.ts"),
  "utf8",
);

test("synced preference route delegates persistence to a repository", () => {
  assert.doesNotMatch(routeSource, /from\s+["']\.\.\/db\/schema["']/);
  assert.doesNotMatch(routeSource, /\bgetDb\s*\(/);
  assert.doesNotMatch(routeSource, /\.prepare\s*\(/);
  assert.match(routeSource, /userPreferencesSyncRepository\.getByUserAsync/);
  assert.match(routeSource, /userPreferencesSyncRepository\.upsertAsync/);
});

test("synced preference repository uses the runtime database adapter", () => {
  assert.match(repositorySource, /getDatabaseAdapter/);
  assert.match(repositorySource, /ON CONFLICT\("userId"\) DO UPDATE/);
});
