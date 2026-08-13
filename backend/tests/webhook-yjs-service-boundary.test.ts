import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../src", relativePath), "utf8");
}

const webhookSource = read("services/webhook.ts");
const yjsSource = read("services/yjs.ts");
const webhookRepositorySource = read("repositories/webhookRepository.ts");
const yjsRepositorySource = read("repositories/yjsPersistenceRepository.ts");

for (const [name, source] of [
  ["webhook", webhookSource],
  ["yjs", yjsSource],
] as const) {
  test(`${name} service keeps SQLite access behind repositories`, () => {
    assert.doesNotMatch(source, /from\s+["']\.\.\/db\/schema(?:\.js)?["']/);
    assert.doesNotMatch(source, /\bgetDb\s*\(/);
    assert.doesNotMatch(source, /\.prepare\s*\(/);
    assert.doesNotMatch(source, /\.transaction\s*\(/);
    assert.doesNotMatch(source, /\.exec\s*\(/);
  });
}

test("webhook service preserves signing, retry and non-blocking delivery semantics", () => {
  assert.match(webhookSource, /createHmac\("sha256", secret\)/);
  assert.match(webhookSource, /maxRetries: number = 3/);
  assert.match(webhookSource, /setTimeout\(\(\) => controller\.abort\(\), 10000\)/);
  assert.match(webhookSource, /1000 \* Math\.pow\(2, attempt - 1\)/);
  assert.match(webhookSource, /webhookRepository\.recordDelivery/);
  assert.match(webhookSource, /日志写入失败不影响主流程/);
  assert.match(webhookRepositorySource, /CREATE TABLE IF NOT EXISTS webhooks/);
  assert.match(webhookRepositorySource, /CREATE TABLE IF NOT EXISTS webhook_deliveries/);
});

test("Yjs service delegates seed, snapshot transaction and note dual-write", () => {
  assert.match(yjsSource, /yjsPersistenceRepository\.getNoteSeed\(noteId\)/);
  assert.match(yjsSource, /yjsPersistenceRepository\.writeSnapshot\(noteId, Buffer\.from\(state\)\)/);
  assert.match(yjsSource, /yjsPersistenceRepository\.getNoteVersion\(room\.noteId\)/);
  assert.match(yjsSource, /yjsPersistenceRepository\.updateNoteContent/);
  assert.match(yjsSource, /VERSION_BUMP_INTERVAL_MS = 5 \* 60 \* 1000/);
  assert.match(yjsSource, /SNAPSHOT_EVERY_N_UPDATES = 100/);
  assert.match(yjsRepositorySource, /db\.transaction/);
  assert.match(yjsRepositorySource, /version = version \+ 1/);
  assert.match(yjsRepositorySource, /updatedAt = datetime\('now'\)/);
});
