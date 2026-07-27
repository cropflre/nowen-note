import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNoteDeletionEffectsRuntime } from "../src/services/note-deletion-effects-runtime";
import { createNoteDeletionRuntime } from "../src/services/note-deletion-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-effects-owner";
const NOTEBOOK = "pg-effects-notebook";
const SINGLE_NOTE = "d1111111-1111-4111-8111-111111111111";
const TRASH_NOTE_1 = "d2222222-2222-4222-8222-222222222222";
const TRASH_NOTE_2 = "d3333333-3333-4333-8333-333333333333";
const WEBHOOK_ID = "pg-effects-webhook";
const WEBHOOK_SECRET = "pg-effects-secret";

const FAILURE_OWNER = "pg-effects-failure-owner";
const FAILURE_NOTEBOOK = "pg-effects-failure-notebook";
const FAILURE_NOTE = "d4444444-4444-4444-8444-444444444444";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function seedSuccessfulFlow(pool: import("pg").Pool, webhookUrl: string) {
  await pool.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0)`,
    [OWNER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name)
     VALUES ($1, $2, NULL, 'Effects notebook')`,
    [NOTEBOOK, OWNER],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "workspaceId", "notebookId", title, content,
       "contentText", "contentFormat", "isTrashed", "isLocked", version
     ) VALUES
       ($1, $4, NULL, $5, 'Single', '# Single', 'Single', 'markdown', false, false, 1),
       ($2, $4, NULL, $5, 'Trash one', '# One', 'One', 'markdown', true, false, 1),
       ($3, $4, NULL, $5, 'Trash two', '# Two', 'Two', 'markdown', true, false, 1)`,
    [SINGLE_NOTE, TRASH_NOTE_1, TRASH_NOTE_2, OWNER, NOTEBOOK],
  );
  await pool.query(
    `INSERT INTO webhooks (
       id, "userId", url, secret, events, "isActive", description
     ) VALUES ($1, $2, $3, $4, $5, true, 'Deletion effects test')`,
    [
      WEBHOOK_ID,
      OWNER,
      webhookUrl,
      WEBHOOK_SECRET,
      JSON.stringify(["note.deleted", "note.trash_emptied"]),
    ],
  );
}

async function seedFailureFlow(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id = $1`, [FAILURE_OWNER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0)`,
    [FAILURE_OWNER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name)
     VALUES ($1, $2, NULL, 'Effects failure notebook')`,
    [FAILURE_NOTEBOOK, FAILURE_OWNER],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "workspaceId", "notebookId", title, content,
       "contentText", "contentFormat", "isTrashed", "isLocked", version
     ) VALUES ($1, $2, NULL, $3, 'Failure', '# Failure', 'Failure', 'markdown', false, false, 1)`,
    [FAILURE_NOTE, FAILURE_OWNER, FAILURE_NOTEBOOK],
  );
}

test("PostgreSQL deletion effects write audit, enqueue webhooks and publish realtime after commit", { skip: !hasPg }, async () => {
  const requests: Array<{
    event: string;
    signature: string;
    body: string;
  }> = [];
  const webhookServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      requests.push({
        event: String(req.headers["x-nowen-event"] || ""),
        signature: String(req.headers["x-nowen-signature"] || ""),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.statusCode = 204;
      res.end();
    });
  });
  const port = await listen(webhookServer);
  const pool = await getPgPool();
  assert.ok(pool);
  let effects: ReturnType<typeof createNoteDeletionEffectsRuntime> | null = null;
  try {
    await initPgSchema(pool);
    await seedSuccessfulFlow(pool, `http://127.0.0.1:${port}/hook`);
    const adapter = new PostgresAdapter(pool);
    const realtimeEvents: string[] = [];
    effects = createNoteDeletionEffectsRuntime(adapter, {
      publishRealtime: async (event) => {
        const committed = await pool.query(
          `SELECT COUNT(*)::int AS count FROM notes WHERE id = ANY($1::text[])`,
          [[
            ...(event.kind === "note.deleted" ? [event.noteId] : event.noteIds),
          ]],
        );
        assert.equal(Number(committed.rows[0].count), 0, "realtime must run after commit");
        realtimeEvents.push(event.kind);
      },
      webhookRetryBaseMs: 1,
      webhookTimeoutMs: 1_000,
    });
    const runtime = createNoteDeletionRuntime(adapter, {
      cleanupAttachments: async () => ({ removedFiles: 0, skippedSharedPaths: 0, warnings: [] }),
      dispatchEffects: effects.dispatch,
    });

    const single = await runtime.permanentDeleteNote(OWNER, SINGLE_NOTE);
    assert.deepEqual(single.sideEffectWarnings, []);
    const batch = await runtime.emptyTrash(OWNER);
    assert.equal(batch.count, 2);
    assert.deepEqual(batch.sideEffectWarnings, []);

    await effects.shutdown();

    const audits = await pool.query(
      `SELECT action, "targetType", "targetId", details
         FROM audit_logs
        WHERE "userId" = $1 AND action IN ('delete', 'trash_empty')
        ORDER BY action`,
      [OWNER],
    );
    assert.equal(audits.rows.length, 2);
    assert.deepEqual(audits.rows.map((row) => row.action).sort(), ["delete", "trash_empty"]);
    assert.equal(audits.rows.find((row) => row.action === "delete")?.targetId, SINGLE_NOTE);

    const deliveries = await pool.query(
      `SELECT event, success, attempts FROM webhook_deliveries WHERE "webhookId" = $1 ORDER BY event`,
      [WEBHOOK_ID],
    );
    assert.equal(deliveries.rows.length, 2);
    assert.deepEqual(deliveries.rows.map((row) => row.event).sort(), ["note.deleted", "note.trash_emptied"]);
    assert.ok(deliveries.rows.every((row) => row.success === true && Number(row.attempts) === 1));

    assert.deepEqual(realtimeEvents.sort(), ["note.deleted", "note.trash_emptied"]);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      const expected = crypto
        .createHmac("sha256", WEBHOOK_SECRET)
        .update(request.body)
        .digest("hex");
      assert.equal(request.signature, `sha256=${expected}`);
      assert.equal(JSON.parse(request.body).event, request.event);
    }
  } finally {
    if (effects) await effects.shutdown();
    await closePgPool(pool);
    await closeServer(webhookServer);
  }
});

test("audit, webhook and realtime failures stay best-effort after deletion commit", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seedFailureFlow(pool);
    const adapter = new PostgresAdapter(pool);
    const effects = createNoteDeletionEffectsRuntime(adapter, {
      recordAudit: async () => { throw new Error("audit unavailable"); },
      dispatchWebhook: async () => { throw new Error("webhook unavailable"); },
      publishRealtime: async () => { throw new Error("realtime unavailable"); },
    });
    const runtime = createNoteDeletionRuntime(adapter, {
      cleanupAttachments: async () => ({ removedFiles: 0, skippedSharedPaths: 0, warnings: [] }),
      dispatchEffects: effects.dispatch,
    });

    const result = await runtime.permanentDeleteNote(FAILURE_OWNER, FAILURE_NOTE);
    assert.equal(result.success, true);
    assert.equal(result.sideEffectWarnings.length, 3);
    assert.match(result.sideEffectWarnings[0], /audit unavailable/);
    assert.match(result.sideEffectWarnings[1], /webhook unavailable/);
    assert.match(result.sideEffectWarnings[2], /realtime unavailable/);
    const remaining = await pool.query(`SELECT COUNT(*)::int AS count FROM notes WHERE id = $1`, [FAILURE_NOTE]);
    assert.equal(Number(remaining.rows[0].count), 0);
  } finally {
    await closePgPool(pool);
  }
});
