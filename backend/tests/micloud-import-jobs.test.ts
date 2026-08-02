import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import "../src/runtime/knowledge-tree-migration-bootstrap.js";
import { getDb, closeDb } from "../src/db/schema.js";
import miCloudRouter from "../src/routes/micloud.js";
import "../src/runtime/micloud-import-hardening.js";
import "../src/runtime/micloud-import-jobs.js";

const USER_ID = "micloud-job-test-user";
const originalFetch = globalThis.fetch;

function createApp(): Hono {
  const app = new Hono();
  app.route("/api/micloud", miCloudRouter);
  return app;
}

const app = createApp();

function resetDatabase(): void {
  const db = getDb();
  db.exec(`
    DROP TRIGGER IF EXISTS micloud_job_test_fail_note;
    DELETE FROM micloud_import_job_items;
    DELETE FROM micloud_import_jobs;
    DELETE FROM note_import_origins;
    DELETE FROM notes;
    DELETE FROM notebooks;
    DELETE FROM users;
  `);
  db.prepare(`
    INSERT INTO users (id, username, passwordHash, role)
    VALUES (?, ?, ?, 'admin')
  `).run(USER_ID, `micloud-job-${Date.now()}`, "test-password-hash");
}

function installMiCloudFetchMock(delayMs = 0): void {
  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const rawUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const url = new URL(rawUrl);
    const match = url.pathname.match(/\/note\/note\/([^/]+)\/?$/);
    if (!match) {
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const noteId = decodeURIComponent(match[1]);
    const title = noteId === "bad-note" ? "Bad note" : `Title ${noteId}`;
    return new Response(JSON.stringify({
      code: 0,
      data: {
        entry: {
          id: noteId,
          subject: title,
          content: `<size>${title}</size>\n正文 ${noteId}`,
          createDate: 1_420_070_400_000,
          modifyDate: 1_420_070_460_000,
        },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

async function createJob(noteIds: string[]) {
  const response = await app.request("/api/micloud/import-jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": USER_ID,
    },
    body: JSON.stringify({ cookie: "serviceToken=test", noteIds }),
  });
  const payload = await response.json() as any;
  return { response, payload };
}

async function waitForTerminal(jobId: string, timeoutMs = 5_000): Promise<any> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await app.request(`/api/micloud/import-jobs/${jobId}`, {
      headers: { "X-User-Id": USER_ID },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    if (["completed", "partial", "failed", "cancelled"].includes(payload.job.status)) {
      return payload.job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job ${jobId} did not finish`);
}

beforeEach(() => {
  resetDatabase();
  installMiCloudFetchMock();
});

after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
});

test("creates one background job and imports every returned row with bounded worker concurrency", async () => {
  const rows = ["note-1", "note-1", "note-2", "note-1"];
  const { response, payload } = await createJob(rows);

  assert.equal(response.status, 202);
  assert.equal(payload.job.total, 4);
  assert.equal(payload.job.status, "queued");

  const completed = await waitForTerminal(payload.job.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.processed, 4);
  assert.equal(completed.succeeded, 4);
  assert.equal(completed.failed, 0);

  const notes = getDb().prepare(`
    SELECT title FROM notes ORDER BY createdAt, id
  `).all() as Array<{ title: string }>;
  assert.equal(notes.length, 4);
  assert.equal(notes.filter((row) => row.title === "Title note-1").length, 3);
  assert.equal(notes.filter((row) => row.title === "Title note-2").length, 1);

  const items = getDb().prepare(`
    SELECT sequence, externalId, status
    FROM micloud_import_job_items
    WHERE jobId = ?
    ORDER BY sequence
  `).all(payload.job.id) as Array<{ sequence: number; externalId: string; status: string }>;
  assert.deepEqual(items.map((item) => item.externalId), rows);
  assert.ok(items.every((item) => item.status === "succeeded"));
});

test("rejects a second active job instead of starting duplicate import traffic", async () => {
  installMiCloudFetchMock(30);
  const first = await createJob(Array.from({ length: 20 }, (_, index) => `note-${index}`));
  assert.equal(first.response.status, 202);

  const second = await createJob(["another-note"]);
  assert.equal(second.response.status, 409);
  assert.equal(second.payload.code, "MICLOUD_IMPORT_JOB_ACTIVE");
  assert.equal(second.payload.job.id, first.payload.job.id);

  await waitForTerminal(first.payload.job.id);
});

test("isolates failed items and can retry only the failed rows", async () => {
  const db = getDb();
  db.exec(`
    CREATE TRIGGER micloud_job_test_fail_note
    BEFORE INSERT ON notes
    WHEN NEW.title = 'Bad note'
    BEGIN
      SELECT RAISE(ABORT, 'forced job note failure');
    END;
  `);

  const first = await createJob(["good-note", "bad-note"]);
  const partial = await waitForTerminal(first.payload.job.id);
  assert.equal(partial.status, "partial");
  assert.equal(partial.succeeded, 1);
  assert.equal(partial.failed, 1);
  assert.match(partial.errors[0], /forced job note failure/);

  db.exec("DROP TRIGGER micloud_job_test_fail_note");
  const retryResponse = await app.request(
    `/api/micloud/import-jobs/${first.payload.job.id}/retry-failed`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": USER_ID,
      },
      body: JSON.stringify({ cookie: "serviceToken=test" }),
    },
  );
  const retryPayload = await retryResponse.json() as any;
  assert.equal(retryResponse.status, 202);
  assert.equal(retryPayload.job.total, 1);
  assert.equal(retryPayload.job.retryOfJobId, first.payload.job.id);

  const completed = await waitForTerminal(retryPayload.job.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.succeeded, 1);
});

test("completed jobs expose a single SSE snapshot and close the stream", async () => {
  const created = await createJob(["note-sse"]);
  const completed = await waitForTerminal(created.payload.job.id);
  assert.equal(completed.status, "completed");

  const response = await app.request(
    `/api/micloud/import-jobs/${created.payload.job.id}/events`,
    { headers: { "X-User-Id": USER_ID } },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  const body = await response.text();
  assert.match(body, /event: done/);
  assert.match(body, /"status":"completed"/);
});
