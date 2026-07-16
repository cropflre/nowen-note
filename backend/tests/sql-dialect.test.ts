import assert from "node:assert/strict";
import test from "node:test";
import { convertPlaceholders, convertSql } from "../src/db/dialect";

test("placeholder conversion skips quoted strings, identifiers and comments", () => {
  const sql = `SELECT '?' AS literal, "question?" FROM notes WHERE id = ? -- ?\nAND title = ?`;
  assert.equal(
    convertPlaceholders(sql, "postgres"),
    `SELECT '?' AS literal, "question?" FROM notes WHERE id = $1 -- ?\nAND title = $2`,
  );
});

test("PostgreSQL conversion quotes camelCase and converts current time", () => {
  assert.equal(
    convertSql(
      `UPDATE ai_custom_prompts SET updatedAt = datetime('now') WHERE id = ? AND userId = ?`,
      "postgres",
    ),
    `UPDATE ai_custom_prompts SET "updatedAt" = NOW() WHERE id = $1 AND "userId" = $2`,
  );
});

test("PostgreSQL conversion maps common boolean predicates", () => {
  assert.equal(
    convertSql(
      `SELECT id FROM calendar_export_targets WHERE enabled = 1 AND COALESCE(isDeleted, 0) = 0`,
      "postgres",
    ),
    `SELECT id FROM calendar_export_targets WHERE enabled = true AND COALESCE("isDeleted", false) = false`,
  );
});

test("PostgreSQL conversion maps INSERT OR IGNORE to ON CONFLICT DO NOTHING", () => {
  assert.equal(
    convertSql(
      `INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?);`,
      "postgres",
    ),
    `INSERT INTO note_tags ("noteId", "tagId") VALUES ($1, $2) ON CONFLICT DO NOTHING ;`,
  );
});
