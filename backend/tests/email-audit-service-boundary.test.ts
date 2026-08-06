import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../src", relativePath), "utf8");
}

const emailSource = read("services/email.ts");
const auditSource = read("services/audit.ts");
const auditRepositorySource = read("repositories/auditRepository.ts");

for (const [name, source] of [
  ["email", emailSource],
  ["audit", auditSource],
] as const) {
  test(`${name} service keeps database access behind repositories`, () => {
    assert.doesNotMatch(source, /from\s+["'][^"']*db\/schema(?:\.js)?["']/);
    assert.doesNotMatch(source, /\bgetDb\s*\(/);
    assert.doesNotMatch(source, /\.prepare\s*\(/);
    assert.doesNotMatch(source, /\.exec\s*\(/);
  });
}

test("SMTP configuration uses the shared system settings repository", () => {
  assert.match(emailSource, /systemSettingsRepository\.get\(SETTING_KEY\)/);
  assert.match(emailSource, /systemSettingsRepository\.set\(SETTING_KEY, value\)/);
  assert.match(emailSource, /aes-256-gcm/);
  assert.match(emailSource, /passwordEnc/);
  assert.match(emailSource, /hasPassword/);
});

test("audit service delegates persistence while preserving safety limits", () => {
  assert.match(auditSource, /auditRepository\.init\(\)/);
  assert.match(auditSource, /auditRepository\.insert\(\{/);
  assert.match(auditSource, /details:\s*details\.slice\(0, 5000\)/);
  assert.match(auditSource, /auditRepository\.query\(params\)/);
  assert.match(auditSource, /auditRepository\.cleanupBefore\(cutoff\)/);
});

test("audit repository retains schema, filters, ordering and cleanup semantics", () => {
  assert.match(auditRepositorySource, /CREATE TABLE IF NOT EXISTS audit_logs/);
  assert.match(auditRepositorySource, /CREATE INDEX IF NOT EXISTS idx_audit_time/);
  assert.match(auditRepositorySource, /ORDER BY createdAt DESC LIMIT \? OFFSET \?/);
  assert.match(auditRepositorySource, /Math\.min\(params\.limit \|\| 50, 200\)/);
  assert.match(auditRepositorySource, /DELETE FROM audit_logs WHERE createdAt < \?/);
});
