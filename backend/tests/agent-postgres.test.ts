import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";

test("PostgreSQL Agent metadata migration is repeatable and enforces active-run and approval uniqueness", { skip: !process.env.TEST_PG_DATABASE_URL }, async () => {
  const client = new Client({ connectionString: process.env.TEST_PG_DATABASE_URL });
  const schema = `agent_${randomUUID().replaceAll("-", "")}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('owner');`);
    const sql = fs.readFileSync(new URL("../src/db/postgres/migrations/0136-editor-agent.sql", import.meta.url), "utf8");
    await client.query(sql); await client.query(sql);
    const insert = `INSERT INTO agent_runs(id,"userId","noteId",status,model,"expectedVersion","snapshotDigest","serverDigest","createdAt","updatedAt") VALUES ($1,'owner','note','running','model',1,'digest','server-digest','2026-10-21','2026-10-21')`;
    await client.query(insert, ["run"]);
    await assert.rejects(client.query(insert, ["duplicate"]), /duplicate key/);
    await client.query(`INSERT INTO agent_approvals(id,"runId","userId","actionType","noteId","payloadDigest","expectedRevision","tokenDigest",status,"expiresAt") VALUES ('approval','run','owner','apply_note_edit','note','hash','revision','hash','pending','2026-10-21')`);
    await assert.rejects(client.query(`INSERT INTO agent_approvals(id,"runId","userId","actionType","noteId","payloadDigest","expectedRevision","tokenDigest",status,"expiresAt") SELECT 'duplicate',"runId","userId","actionType","noteId","payloadDigest","expectedRevision","tokenDigest",status,"expiresAt" FROM agent_approvals`), /duplicate key/);
    await client.query(`BEGIN; UPDATE agent_approvals SET status='consumed'; ROLLBACK;`);
    assert.equal((await client.query("SELECT status FROM agent_approvals")).rows[0].status, "pending");
    await client.query("DELETE FROM users WHERE id='owner'");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM agent_approvals")).rows[0].n, 0);
  } finally { await client.query("ROLLBACK").catch(() => undefined); await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end(); }
});
