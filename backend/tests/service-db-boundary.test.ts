import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../src", relativePath), "utf8");
}

const realtimeSource = read("services/realtime.ts");
const attachmentStorageSource = read("services/attachment-storage.ts");
const realtimeRepositorySource = read("repositories/realtimeAuthRepository.ts");

for (const [name, source] of [
  ["realtime", realtimeSource],
  ["attachment-storage", attachmentStorageSource],
] as const) {
  test(`${name} service keeps database access behind repositories`, () => {
    assert.doesNotMatch(source, /from\s+["']\.\.\/db\/schema["']/);
    assert.doesNotMatch(source, /\bgetDb\s*\(/);
    assert.doesNotMatch(source, /\.prepare\s*\(/);
  });
}

test("attachment storage uses the shared system settings repository", () => {
  assert.match(attachmentStorageSource, /systemSettingsRepository\.get\(SETTING_KEY\)/);
  assert.match(attachmentStorageSource, /systemSettingsRepository\.set\(SETTING_KEY/);
  assert.match(attachmentStorageSource, /systemSettingsRepository\.delete\(SETTING_KEY\)/);
});

test("realtime authentication delegates user lookup to its repository", () => {
  assert.match(realtimeSource, /realtimeAuthRepository\.findById\(payload\.userId\)/);
  assert.match(realtimeRepositorySource, /SELECT id, username/);
  assert.match(realtimeRepositorySource, /"isDisabled"/);
  assert.match(realtimeRepositorySource, /"tokenVersion"/);
});
