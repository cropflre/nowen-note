import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function assertOrderedImports(
  source: string,
  firstImport: string,
  secondImport: string,
  entryLabel: string,
): void {
  const firstIndex = source.indexOf(firstImport);
  const secondIndex = source.indexOf(secondImport);
  assert.ok(firstIndex >= 0, `${entryLabel} must contain ${firstImport}`);
  assert.ok(secondIndex >= 0, `${entryLabel} must contain ${secondImport}`);
  assert.ok(
    firstIndex < secondIndex,
    `${entryLabel} must register feature migrations before database-consuming runtimes`,
  );
}

test("knowledge-tree bootstrap registers schema versions 60-64 before migrations.ts is evaluated", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  const { CURRENT_SCHEMA_VERSION, MIGRATIONS } = await import("../src/db/migrations");
  const versions = new Set(MIGRATIONS.map((migration) => migration.version));

  for (const version of [60, 61, 62, 63, 64]) {
    assert.ok(versions.has(version), `feature migration v${version} must be registered`);
  }
  assert.ok(
    CURRENT_SCHEMA_VERSION >= 64,
    `expected schema support >= 64, received ${CURRENT_SCHEMA_VERSION}`,
  );
});

test("permission routes load after migration bootstrap in hardened and legacy entries", () => {
  const hardenedIndexSource = fs.readFileSync(
    path.resolve(__dirname, "../src/index.hardened.ts"),
    "utf8",
  );
  const legacyIndexSource = fs.readFileSync(
    path.resolve(__dirname, "../src/index.ts"),
    "utf8",
  );
  const taskStatsRuntimeSource = fs.readFileSync(
    path.resolve(__dirname, "../src/runtime/task-stats-hardening.ts"),
    "utf8",
  );
  const bootstrapSource = fs.readFileSync(
    path.resolve(__dirname, "../src/runtime/knowledge-tree-migration-bootstrap.ts"),
    "utf8",
  );

  assertOrderedImports(
    hardenedIndexSource,
    'import "./runtime/knowledge-tree-migration-bootstrap.js";',
    'import "./runtime/notebook-permission-management.js";',
    "index.hardened",
  );
  assertOrderedImports(
    legacyIndexSource,
    'import "./runtime/knowledge-tree-migration-bootstrap";',
    'import "./runtime/task-stats-hardening";',
    "index",
  );
  assert.match(
    taskStatsRuntimeSource,
    /import\s+["']\.\/notebook-permission-management\.js["'];/,
    "legacy startup runtime must install notebook permission routes",
  );
  assert.doesNotMatch(
    bootstrapSource,
    /import\s+["']\.\/notebook-permission-management\.js["']/,
    "migration bootstrap must not import database-consuming runtimes",
  );
});