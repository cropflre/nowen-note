import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Hono } from "hono";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import {
  createAttachmentsRuntimeRouter,
  handleAttachmentDownloadRuntime,
} from "../src/routes/attachments-runtime";
import { createAttachmentStorageRuntime } from "../src/services/attachment-storage-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-attachment-owner";
const READER = "pg-attachment-reader";
const OTHER = "pg-attachment-other";
const WORKSPACE = "pg-attachment-workspace";
const NOTEBOOK = "pg-attachment-notebook";
const NOTE = "11111111-aaaa-4111-8111-111111111111";

async function resetFixture(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, READER, OTHER]]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion") VALUES
       ($1, 'pg_attachment_owner', 'hash', 0),
       ($2, 'pg_attachment_reader', 'hash', 0),
       ($3, 'pg_attachment_other', 'hash', 0)`,
    [OWNER, READER, OTHER],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, 'Attachment Workspace', $2)`,
    [WORKSPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES ($1, $2, 'owner')`,
    [WORKSPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name, "workspaceId") VALUES ($1, $2, 'Attachments', $3)`,
    [NOTEBOOK, OWNER, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", version, "workspaceId"
     ) VALUES ($1, $2, $3, 'Attachment note', '{}', '', 'tiptap-json', 1, $4)`,
    [NOTE, OWNER, NOTEBOOK, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO note_acl ("noteId", "userId", permission, "grantedBy") VALUES ($1, $2, 'read', $3)`,
    [NOTE, READER, OWNER],
  );
  await pool.query(`DELETE FROM system_settings WHERE key = 'attachmentStorage:config'`);
}

function createApp(adapter: PostgresAdapter, dataDir: string) {
  const app = new Hono();
  app.get("/api/attachments/:id", (c) => handleAttachmentDownloadRuntime(c, adapter, { dataDir }));
  app.route("/api/attachments", createAttachmentsRuntimeRouter(adapter, { dataDir, maxSizeBytes: 1024 * 1024 }));
  return app;
}

async function upload(
  app: Hono,
  userId: string,
  bytes: Uint8Array,
  filename = "pixel.png",
  mimeType = "image/png",
) {
  const form = new FormData();
  form.set("noteId", NOTE);
  form.set("file", new File([bytes], filename, { type: mimeType }));
  return app.request("/api/attachments", {
    method: "POST",
    headers: { "X-User-Id": userId },
    body: form,
  });
}

test("PostgreSQL attachment runtime completes signed upload/read/revoke/dedup/delete lifecycle", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nowen-pg-attachment-http-"));
  try {
    await initPgSchema(pool);
    await resetFixture(pool);
    const adapter = new PostgresAdapter(pool);
    const storage = createAttachmentStorageRuntime(adapter, { dataDir });
    const app = createApp(adapter, dataDir);
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5]);

    const deniedUpload = await upload(app, OTHER, bytes);
    assert.equal(deniedUpload.status, 403);

    const firstUpload = await upload(app, OWNER, bytes);
    const firstText = await firstUpload.text();
    assert.equal(firstUpload.status, 201, firstText);
    const first = JSON.parse(firstText) as {
      id: string;
      url: string;
      accessUrls: Record<string, string>;
      category: string;
      deduplicated?: boolean;
    };
    assert.ok(first.id);
    assert.equal(first.category, "image");
    assert.equal(first.deduplicated, undefined);
    assert.match(first.accessUrls[first.id], new RegExp(`^/api/attachments/${first.id}\\?`));

    const metadata = await pool.query<{ path: string; hash: string }>(
      `SELECT path, hash FROM attachments WHERE id = $1`,
      [first.id],
    );
    assert.equal(metadata.rowCount, 1);
    const firstPath = metadata.rows[0].path;
    assert.ok(firstPath);
    assert.equal((metadata.rows[0].hash || "").length, 64);
    assert.deepEqual(await storage.readObject(firstPath), Buffer.from(bytes));

    const raw = await app.request(first.url);
    assert.equal(raw.status, 404);

    const signed = await app.request(first.accessUrls[first.id]);
    assert.equal(signed.status, 200);
    assert.equal(signed.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await signed.arrayBuffer()), Buffer.from(bytes));
    const etag = signed.headers.get("etag");
    assert.ok(etag);

    const notModified = await app.request(first.accessUrls[first.id], {
      headers: { "If-None-Match": etag! },
    });
    assert.equal(notModified.status, 304);

    const range = await app.request(first.accessUrls[first.id], {
      headers: { Range: "bytes=2-5" },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), `bytes 2-5/${bytes.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.from(bytes.slice(2, 6)));

    const tampered = new URL(first.accessUrls[first.id], "http://nowen.test");
    tampered.searchParams.set("sig", `${tampered.searchParams.get("sig")?.slice(0, -1) || ""}0`);
    const tamperedResponse = await app.request(`${tampered.pathname}${tampered.search}`);
    assert.equal(tamperedResponse.status, 403);

    const readerAccess = await app.request(`/api/attachments/access/urls?noteId=${NOTE}`, {
      headers: { "X-User-Id": READER },
    });
    const readerText = await readerAccess.text();
    assert.equal(readerAccess.status, 200, readerText);
    const readerBody = JSON.parse(readerText) as { urls: Record<string, string> };
    assert.ok(readerBody.urls[first.id]);
    const readerSigned = await app.request(readerBody.urls[first.id]);
    assert.equal(readerSigned.status, 200);

    await pool.query(`DELETE FROM note_acl WHERE "noteId" = $1 AND "userId" = $2`, [NOTE, READER]);
    const revokedReplay = await app.request(readerBody.urls[first.id]);
    assert.equal(revokedReplay.status, 403);
    assert.equal(((await revokedReplay.json()) as any).code, "ATTACHMENT_ACCESS_REVOKED");

    const secondUpload = await upload(app, OWNER, bytes, "same.png");
    const secondText = await secondUpload.text();
    assert.equal(secondUpload.status, 201, secondText);
    const second = JSON.parse(secondText) as {
      id: string;
      accessUrls: Record<string, string>;
      deduplicated?: boolean;
    };
    assert.notEqual(second.id, first.id);
    assert.equal(second.deduplicated, true);

    const dedupPaths = await pool.query<{ id: string; path: string }>(
      `SELECT id, path FROM attachments WHERE id = ANY($1::text[]) ORDER BY id`,
      [[first.id, second.id]],
    );
    assert.equal(dedupPaths.rowCount, 2);
    assert.equal(new Set(dedupPaths.rows.map((row) => row.path)).size, 1);

    const deleteFirst = await app.request(`/api/attachments/${first.id}`, {
      method: "DELETE",
      headers: { "X-User-Id": OWNER },
    });
    assert.equal(deleteFirst.status, 200);
    assert.deepEqual(await storage.readObject(firstPath), Buffer.from(bytes));
    assert.equal((await app.request(second.accessUrls[second.id])).status, 200);

    const deleteSecond = await app.request(`/api/attachments/${second.id}`, {
      method: "DELETE",
      headers: { "X-User-Id": OWNER },
    });
    assert.equal(deleteSecond.status, 200);
    assert.equal(await storage.readObject(firstPath), null);

    const metadataGone = await pool.query(`SELECT id FROM attachments WHERE id = ANY($1::text[])`, [[first.id, second.id]]);
    assert.equal(metadataGone.rowCount, 0);
  } finally {
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, READER, OTHER]]).catch(() => {});
    await fs.promises.rm(dataDir, { recursive: true, force: true });
    await closePgPool(pool);
  }
});
