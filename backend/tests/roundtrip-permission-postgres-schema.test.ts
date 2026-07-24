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

function tableSection(name: string, nextMarker: string): string {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
  const end = schema.indexOf(nextMarker, start);
  assert.ok(start >= 0, `${name} must exist in PostgreSQL schema`);
  assert.ok(end > start, `${name} schema section must be bounded`);
  return schema.slice(start, end);
}

test("PostgreSQL permission tables expose the v2 transfer fields", () => {
  const workspaceMembers = tableSection("workspace_members", "CREATE TABLE IF NOT EXISTS workspace_invites");
  assert.match(workspaceMembers, /"workspaceId"\s+TEXT\s+NOT NULL/);
  assert.match(workspaceMembers, /"userId"\s+TEXT\s+NOT NULL/);
  assert.match(workspaceMembers, /\brole\s+TEXT\s+NOT NULL/);
  assert.match(workspaceMembers, /"joinedAt"\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT NOW\(\)/);
  assert.match(workspaceMembers, /PRIMARY KEY \("workspaceId", "userId"\)/);

  const notebookMembers = tableSection("notebook_members", "CREATE TABLE IF NOT EXISTS notebook_share_links");
  assert.match(notebookMembers, /"notebookId"\s+TEXT\s+NOT NULL/);
  assert.match(notebookMembers, /"userId"\s+TEXT\s+NOT NULL/);
  assert.match(notebookMembers, /\brole\s+TEXT\s+NOT NULL/);
  assert.match(notebookMembers, /\bstatus\s+TEXT\s+NOT NULL/);
  assert.match(notebookMembers, /"allowDownload"\s+INTEGER\s+NOT NULL/);
  assert.match(notebookMembers, /"allowReshare"\s+INTEGER\s+NOT NULL/);
  assert.match(notebookMembers, /\bsource\s+TEXT\s+NOT NULL/);
  assert.match(notebookMembers, /"sourceId"\s+TEXT/);
  assert.match(notebookMembers, /"invitedBy"\s+TEXT/);
});

test("PostgreSQL import batch schema can persist permission reports and undo snapshots", () => {
  const batches = tableSection("roundtrip_import_batches", "CREATE INDEX IF NOT EXISTS idx_roundtrip_import_batches_user");
  assert.match(batches, /"previewJson"\s+TEXT\s+NOT NULL/);
  assert.match(batches, /"resultJson"\s+TEXT\s+NOT NULL/);
  assert.match(batches, /"undoStateJson"\s+TEXT\s+NOT NULL/);
  assert.match(batches, /"undoAvailable"\s+BOOLEAN\s+NOT NULL/);
});
