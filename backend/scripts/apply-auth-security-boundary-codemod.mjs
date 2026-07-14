import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.resolve(here, "../src/lib/auth-security.ts");
let source = fs.readFileSync(filePath, "utf8");

function replaceOnce(from, to, label) {
  if (!source.includes(from)) {
    throw new Error(`auth-security.ts: missing expected fragment: ${label}`);
  }
  source = source.replace(from, to);
}

replaceOnce(
  'import type { Context } from "hono";',
  'import type { Context } from "hono";\nimport { authSecurityRepository, type AuthSecurityDatabase } from "../repositories/authSecurityRepository";',
  "repository import",
);

replaceOnce(
  `  db: import("better-sqlite3").Database,\n  userId: string,`,
  `  db: AuthSecurityDatabase,\n  userId: string,`,
  "checkAccountLock database type",
);

replaceOnce(
  `  const row = db\n    .prepare(\n      "SELECT id, failedLoginAttempts, lastFailedLoginAt, lockedUntil FROM users WHERE id = ?",\n    )\n    .get(userId) as AccountLockRow | undefined;`,
  `  const row = authSecurityRepository.getAccountLock(db, userId);`,
  "account lock lookup",
);

replaceOnce(
  `    db.prepare("UPDATE users SET lockedUntil = NULL, failedLoginAttempts = 0 WHERE id = ?").run(\n      userId,\n    );`,
  `    authSecurityRepository.clearExpiredLock(db, userId);`,
  "expired lock cleanup",
);

replaceOnce(
  `      db.prepare("UPDATE users SET failedLoginAttempts = 0 WHERE id = ?").run(userId);`,
  `      authSecurityRepository.clearFailedAttempts(db, userId);`,
  "expired failure window cleanup",
);

replaceOnce(
  `  db: import("better-sqlite3").Database,\n  userId: string,`,
  `  db: AuthSecurityDatabase,\n  userId: string,`,
  "recordLoginFailure database type",
);

replaceOnce(
  `  const row = db\n    .prepare("SELECT failedLoginAttempts FROM users WHERE id = ?")\n    .get(userId) as { failedLoginAttempts: number } | undefined;\n  if (!row) return { attempts: 0, lockedUntil: null };\n\n  const nextAttempts = row.failedLoginAttempts + 1;`,
  `  const failedLoginAttempts = authSecurityRepository.getFailedLoginAttempts(db, userId);\n  if (failedLoginAttempts === null) return { attempts: 0, lockedUntil: null };\n\n  const nextAttempts = failedLoginAttempts + 1;`,
  "failed login count lookup",
);

replaceOnce(
  `    db.prepare(\n      \`UPDATE users\n       SET failedLoginAttempts = ?, lastFailedLoginAt = ?, lockedUntil = ?\n       WHERE id = ?\`,\n    ).run(nextAttempts, nowIso, lockedUntil, userId);`,
  `    authSecurityRepository.recordLoginFailure(db, {\n      userId,\n      attempts: nextAttempts,\n      failedAt: nowIso,\n      lockedUntil,\n    });`,
  "locked failure write",
);

replaceOnce(
  `  db.prepare(\n    \`UPDATE users\n     SET failedLoginAttempts = ?, lastFailedLoginAt = ?\n     WHERE id = ?\`,\n  ).run(nextAttempts, nowIso, userId);`,
  `  authSecurityRepository.recordLoginFailure(db, {\n    userId,\n    attempts: nextAttempts,\n    failedAt: nowIso,\n    lockedUntil: null,\n  });`,
  "normal failure write",
);

replaceOnce(
  `export function resetLoginFailure(db: import("better-sqlite3").Database, userId: string) {\n  db.prepare(\n    \`UPDATE users\n     SET failedLoginAttempts = 0, lastFailedLoginAt = NULL, lockedUntil = NULL\n     WHERE id = ?\`,\n  ).run(userId);\n}`,
  `export function resetLoginFailure(db: AuthSecurityDatabase, userId: string) {\n  authSecurityRepository.resetLoginFailure(db, userId);\n}`,
  "reset failure delegation",
);

replaceOnce(
  `export function bumpTokenVersion(db: import("better-sqlite3").Database, userId: string): number {\n  db.prepare("UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?").run(userId);\n  const row = db.prepare("SELECT tokenVersion FROM users WHERE id = ?").get(userId) as\n    | { tokenVersion: number }\n    | undefined;\n  // 同时清理 JWT 中间件的缓存，确保新状态立即生效\n  invalidateUserAuthCache(userId);\n  return row?.tokenVersion ?? 0;\n}`,
  `export function bumpTokenVersion(db: AuthSecurityDatabase, userId: string): number {\n  const tokenVersion = authSecurityRepository.bumpTokenVersion(db, userId);\n  // 同时清理 JWT 中间件的缓存，确保新状态立即生效\n  invalidateUserAuthCache(userId);\n  return tokenVersion;\n}`,
  "token version delegation",
);

fs.writeFileSync(filePath, source);
console.log("Applied auth security repository boundary codemod.");
