import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-embedding-index-diagnostics-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.NODE_ENV = "test";

let getDb: typeof import("../src/db/schema").getDb;
let closeDb: typeof import("../src/db/schema").closeDb;
let getEmbeddingFailures: typeof import("../src/services/embedding-index-diagnostics").getEmbeddingFailures;
let retryFailedEmbeddings: typeof import("../src/services/embedding-index-diagnostics").retryFailedEmbeddings;
let publicEmbeddingError: typeof import("../src/services/embedding-index-diagnostics").publicEmbeddingError;
let dueSql: string;

function insertJob(
  type: "note" | "attachment", id: string, userId: string,
  workspaceId: string | null, status: string, lastError: string | null, retries = 1,
): void {
  const db = getDb();
  db.pragma("foreign_keys = OFF");
  try {
    if (type === "note") {
      db.prepare(`INSERT INTO embedding_queue
        (noteId, userId, workspaceId, status, retries, lastError, enqueuedAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, '2000-01-01 00:00:00', datetime('now'))`)
        .run(id, userId, workspaceId, status, retries, lastError);
    } else {
      db.prepare(`INSERT INTO attachment_embedding_queue
        (attachmentId, noteId, userId, workspaceId, status, retries, lastError, enqueuedAt, updatedAt)
        VALUES (?, 'missing-parent', ?, ?, ?, ?, ?, '2000-01-01 00:00:00', datetime('now'))`)
        .run(id, userId, workspaceId, status, retries, lastError);
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

test.before(async () => {
  const [schema, diagnostics, policy] = await Promise.all([
    import("../src/db/schema"),
    import("../src/services/embedding-index-diagnostics"),
    import("../src/services/embedding-retry-policy"),
  ]);
  getDb = schema.getDb;
  closeDb = schema.closeDb;
  getEmbeddingFailures = diagnostics.getEmbeddingFailures;
  retryFailedEmbeddings = diagnostics.retryFailedEmbeddings;
  publicEmbeddingError = diagnostics.publicEmbeddingError;
  dueSql = policy.EMBEDDING_RETRY_DUE_SQL;
});

test.beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM embedding_queue").run();
  db.prepare("DELETE FROM attachment_embedding_queue").run();
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("only authorized scope's failures are summarized; no raw IDs or keys are exposed", () => {
  insertJob("note", "na1", "alice", null, "failed", "HTTP 429 rate limit; Bearer secret");
  insertJob("note", "na2", "alice", null, "failed", "HTTP 401 invalid api key");
  insertJob("attachment", "aa1", "alice", null, "failed", "HTTP 429 too many requests");
  insertJob("note", "nb1", "bob", null, "failed", "HTTP 400 invalid model");
  insertJob("note", "nw1", "bob", "team1", "failed", "HTTP 503 unavailable");

  const alice = getEmbeddingFailures({ userId: "alice", workspaceId: null });
  assert.equal(alice.failed, 3);
  assert.equal(alice.notes, 2);
  assert.equal(alice.attachments, 1);
  assert.equal(alice.reasons.find((r) => r.code === "rate_limit")?.count, 2);
  assert.equal(alice.reasons.find((r) => r.code === "auth")?.count, 1);
  assert.equal(alice.reasons.some((r) => r.code === "provider"), false);
  assert.equal(JSON.stringify(alice).includes("secret"), false);

  // Team membership is checked by resolveScope in the HTTP route.
  assert.equal(getEmbeddingFailures({ userId: "alice", workspaceId: "team1" }).failed, 1);
  assert.equal(getEmbeddingFailures({ userId: "bob", workspaceId: null }).failed, 1);
  assert.equal(publicEmbeddingError("HTTP 429: Bearer sk-secret123456?api_key=keyhere"), "HTTP 429 · 服务商限流或配额不足，请稍后重试");
});

test("failed-only retry resets only the requested space and preserves pending jobs", () => {
  insertJob("note", "na1", "alice", null, "failed", "HTTP 429", 5);
  insertJob("attachment", "aa1", "alice", null, "failed", "HTTP 503", 3);
  insertJob("note", "np1", "alice", null, "pending", null, 0);
  insertJob("note", "nb1", "bob", null, "failed", "HTTP 401", 1);
  insertJob("note", "nw1", "alice", "team1", "failed", "HTTP 400", 1);
  assert.deepEqual(retryFailedEmbeddings({ userId: "alice", workspaceId: null }), {
    notes: 1, attachments: 1, enqueued: 2,
  });
  const db = getDb();
  for (const [table, idColumn, id] of [
    ["embedding_queue", "noteId", "na1"],
    ["attachment_embedding_queue", "attachmentId", "aa1"],
  ]) {
    const row = db.prepare(`SELECT status, retries, lastError FROM ${table} WHERE ${idColumn} = ?`)
      .get(id) as { status: string; retries: number; lastError: string | null };
    assert.deepEqual(row, { status: "pending", retries: 0, lastError: null });
  }
  assert.equal((db.prepare("SELECT status FROM embedding_queue WHERE noteId = 'nb1'").get() as {status:string}).status, "failed");
  assert.equal((db.prepare("SELECT status FROM embedding_queue WHERE noteId = 'nw1'").get() as {status:string}).status, "failed");
  assert.equal((db.prepare("SELECT status FROM embedding_queue WHERE noteId = 'np1'").get() as {status:string}).status, "pending");
  assert.equal(getEmbeddingFailures({ userId: "alice", workspaceId: null }).failed, 0);
});

test("SQL retry guard defers recent requests but accepts new or elapsed retry tasks", () => {
  insertJob("note", "fresh", "alice", null, "pending", null, 0);
  insertJob("note", "limited", "alice", null, "pending", "HTTP 429 rate limit", 1);
  insertJob("note", "timed", "alice", null, "pending", "HTTP 503 unavailable", 2);
  const db = getDb();
  let eligible = db.prepare(`SELECT noteId FROM embedding_queue q WHERE status = 'pending' AND ${dueSql} ORDER BY noteId`)
    .all() as Array<{ noteId: string }>;
  assert.deepEqual(eligible.map((r) => r.noteId), ["fresh"]);
  db.prepare("UPDATE embedding_queue SET updatedAt = datetime('now', '-2 minutes') WHERE noteId IN ('limited', 'timed')").run();
  eligible = db.prepare(`SELECT noteId FROM embedding_queue q WHERE status = 'pending' AND ${dueSql} ORDER BY noteId`)
    .all() as Array<{ noteId: string }>;
  assert.deepEqual(eligible.map((r) => r.noteId), ["fresh", "limited", "timed"]);
});
