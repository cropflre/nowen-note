import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNotesRuntimeRouter } from "../src/routes/notes-runtime";
import type { NoteRuntimeMutationEvent } from "../src/services/note-deletion-realtime-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const USER = "pg-realtime-route-user";
const NOTEBOOK_A = "pg-realtime-route-notebook-a";
const NOTEBOOK_B = "pg-realtime-route-notebook-b";
const NOTE = "a1111111-1111-4111-8111-111111111111";
const CONNECTION = "pg-realtime-route-connection";

async function requestJson(
  router: ReturnType<typeof createNotesRuntimeRouter>,
  path: string,
  method: string,
  body: Record<string, unknown>,
) {
  return router.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": USER,
      "X-Connection-Id": CONNECTION,
    },
    body: JSON.stringify(body),
  });
}

async function prepareFixture(pool: import("pg").Pool): Promise<void> {
  await initPgSchema(pool);
  await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion", "isDisabled")
     VALUES ($1, $1, 'hash', 0, false)`,
    [USER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name) VALUES
       ($1, $3, 'Realtime A'),
       ($2, $3, 'Realtime B')`,
    [NOTEBOOK_A, NOTEBOOK_B, USER],
  );
}

test("PostgreSQL notes router publishes mutation events only after commits", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await prepareFixture(pool);
    const adapter = new PostgresAdapter(pool);
    const events: NoteRuntimeMutationEvent[] = [];
    const router = createNotesRuntimeRouter(adapter, "postgres", {}, {
      publishMutation: async (event) => {
        if (event.kind === "note.created") {
          const row = await pool.query(
            `SELECT title, version FROM notes WHERE id = $1`,
            [event.note.id],
          );
          assert.equal(row.rowCount, 1);
          assert.equal(row.rows[0].title, "Created");
          assert.equal(row.rows[0].version, 1);
        } else if (event.kind === "note.updated") {
          const row = await pool.query(
            `SELECT title, version FROM notes WHERE id = $1`,
            [event.note.id],
          );
          assert.equal(row.rows[0].title, "Updated");
          assert.equal(row.rows[0].version, 2);
        } else if (event.kind === "note.trashed") {
          const row = await pool.query(
            `SELECT "isTrashed" FROM notes WHERE id = $1`,
            [event.note.id],
          );
          assert.equal(row.rows[0].isTrashed, true);
        } else if (event.kind === "note.restored") {
          const row = await pool.query(
            `SELECT "isTrashed" FROM notes WHERE id = $1`,
            [event.note.id],
          );
          assert.equal(row.rows[0].isTrashed, false);
        } else if (event.kind === "note.moved") {
          const row = await pool.query(
            `SELECT "notebookId" FROM notes WHERE id = $1`,
            [event.note.id],
          );
          assert.equal(row.rows[0].notebookId, NOTEBOOK_B);
        } else if (event.kind === "notes.reordered") {
          const row = await pool.query(
            `SELECT "sortOrder" FROM notes WHERE id = $1`,
            [NOTE],
          );
          assert.equal(row.rows[0].sortOrder, 77);
        }
        events.push(event);
      },
    });

    const createdResponse = await requestJson(router, "/", "POST", {
      id: NOTE,
      notebookId: NOTEBOOK_A,
      title: "Created",
      contentFormat: "markdown",
      content: "# Created\n",
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as Record<string, unknown>;
    assert.equal(created.id, NOTE);
    assert.equal(created.version, 1);

    const staleEventCount = events.length;
    const staleResponse = await requestJson(router, `/${NOTE}`, "PUT", {
      version: 999,
      title: "Must not publish",
    });
    assert.equal(staleResponse.status, 409);
    assert.equal(events.length, staleEventCount);

    const updatedResponse = await requestJson(router, `/${NOTE}`, "PUT", {
      version: 1,
      title: "Updated",
    });
    assert.equal(updatedResponse.status, 200);
    const updated = await updatedResponse.json() as Record<string, unknown>;
    assert.equal(updated.title, "Updated");
    assert.equal(updated.version, 2);

    const trashedResponse = await requestJson(router, `/${NOTE}`, "PUT", { isTrashed: 1 });
    assert.equal(trashedResponse.status, 200);
    const restoredResponse = await requestJson(router, `/${NOTE}`, "PUT", { isTrashed: 0 });
    assert.equal(restoredResponse.status, 200);
    const movedResponse = await requestJson(router, `/${NOTE}`, "PUT", { notebookId: NOTEBOOK_B });
    assert.equal(movedResponse.status, 200);

    const reorderedResponse = await requestJson(router, "/reorder/batch", "PUT", {
      items: [{ id: NOTE, sortOrder: 77 }],
    });
    assert.equal(reorderedResponse.status, 200);

    assert.deepEqual(
      events.map((event) => event.kind),
      [
        "note.created",
        "note.updated",
        "note.trashed",
        "note.restored",
        "note.moved",
        "notes.reordered",
      ],
    );
    for (const event of events) {
      assert.equal(event.actorUserId, USER);
      assert.equal(event.actorConnectionId, CONNECTION);
    }
  } finally {
    await closePgPool(pool);
  }
});

test("realtime publishing failure warns without rolling back committed note writes", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await prepareFixture(pool);
    await pool.query(
      `INSERT INTO notes (
         id, "userId", "notebookId", title, content, "contentText", "contentFormat", version
       ) VALUES ($1, $2, $3, 'Before outage', '# Before', 'Before', 'markdown', 1)`,
      [NOTE, USER, NOTEBOOK_A],
    );
    const adapter = new PostgresAdapter(pool);
    const router = createNotesRuntimeRouter(adapter, "postgres", {}, {
      publishMutation: async () => {
        throw new Error("simulated realtime outage");
      },
    });

    const response = await requestJson(router, `/${NOTE}`, "PUT", {
      version: 1,
      title: "Committed during outage",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Nowen-Runtime-Warnings"), "1");
    const body = await response.json() as {
      title: string;
      version: number;
      runtimeWarnings?: string[];
    };
    assert.equal(body.title, "Committed during outage");
    assert.equal(body.version, 2);
    assert.equal(body.runtimeWarnings?.length, 1);
    assert.match(body.runtimeWarnings?.[0] || "", /simulated realtime outage/);

    const stored = await pool.query(
      `SELECT title, version FROM notes WHERE id = $1`,
      [NOTE],
    );
    assert.equal(stored.rows[0].title, "Committed during outage");
    assert.equal(stored.rows[0].version, 2);
  } finally {
    await closePgPool(pool);
  }
});
