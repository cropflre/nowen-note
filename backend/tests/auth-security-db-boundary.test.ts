import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../src", relativePath), "utf8");
}

const securitySource = read("lib/auth-security.ts");
const repositorySource = read("repositories/authSecurityRepository.ts");

test("authentication security helpers keep SQL behind the repository boundary", () => {
  assert.doesNotMatch(securitySource, /better-sqlite3/);
  assert.doesNotMatch(securitySource, /\.prepare\s*\(/);
  assert.doesNotMatch(securitySource, /from\s+["']\.\.\/db\/schema["']/);
  assert.match(securitySource, /authSecurityRepository\.getAccountLock\(db, userId\)/);
  assert.match(securitySource, /authSecurityRepository\.recordLoginFailure\(db,/);
  assert.match(securitySource, /authSecurityRepository\.resetLoginFailure\(db, userId\)/);
  assert.match(securitySource, /authSecurityRepository\.bumpTokenVersion\(db, userId\)/);
});

test("account lock thresholds and cache invalidation remain in the security layer", () => {
  assert.match(securitySource, /const ACCOUNT_MAX_FAIL = 5/);
  assert.match(securitySource, /const ACCOUNT_LOCK_MS = 15 \* 60_000/);
  assert.match(securitySource, /const ACCOUNT_FAIL_WINDOW_MS = 30 \* 60_000/);
  assert.match(securitySource, /invalidateUserAuthCache\(userId\)/);
});

test("repository preserves account lock and token version persistence semantics", () => {
  assert.match(repositorySource, /"failedLoginAttempts"/);
  assert.match(repositorySource, /"lastFailedLoginAt"/);
  assert.match(repositorySource, /"lockedUntil"/);
  assert.match(repositorySource, /"tokenVersion" = "tokenVersion" \+ 1/);
  assert.match(repositorySource, /SELECT "tokenVersion" FROM users WHERE id = \?/);
});
