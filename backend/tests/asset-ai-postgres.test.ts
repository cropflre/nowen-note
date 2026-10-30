import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";

test("PostgreSQL asset AI migration preserves files, supports rollback and prevents metadata transfer leaks",{skip:!process.env.TEST_PG_DATABASE_URL},async()=>{
  const client=new Client({connectionString:process.env.TEST_PG_DATABASE_URL});
  const schema="asset_ai_"+randomUUID().replaceAll("-","");
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
      CREATE TABLE users(id TEXT PRIMARY KEY);
      CREATE TABLE attachments(id TEXT PRIMARY KEY,"userId" TEXT,"workspaceId" TEXT);
      INSERT INTO users VALUES ('owner'),('other');
      INSERT INTO attachments VALUES ('file','owner',NULL);`);
    const migration=fs.readFileSync(new URL("../src/db/postgres/migrations/0130-asset-ai-metadata.sql",import.meta.url),"utf8");
    await client.query(migration);
    await client.query("INSERT INTO asset_descriptions VALUES ('file','Private description',CURRENT_TIMESTAMP)");
    await client.query(migration);
    assert.equal((await client.query("SELECT description FROM asset_descriptions")).rows[0].description,"Private description");
    await client.query("BEGIN; UPDATE attachments SET \"workspaceId\"='team' WHERE id='file'; ROLLBACK;");
    assert.equal((await client.query("SELECT count(*)::int n FROM asset_descriptions")).rows[0].n,1);
    await client.query("UPDATE attachments SET \"workspaceId\"='team' WHERE id='file'");
    assert.equal((await client.query("SELECT count(*)::int n FROM asset_descriptions")).rows[0].n,0);
    await client.query("INSERT INTO asset_descriptions VALUES ('file','New description',CURRENT_TIMESTAMP); DELETE FROM attachments WHERE id='file'");
    assert.equal((await client.query("SELECT count(*)::int n FROM asset_descriptions")).rows[0].n,0);
    await client.query("INSERT INTO asset_ai_batches(\"userId\",\"scopeKey\",\"requestId\",\"payloadHash\",\"resultJson\") VALUES ('owner','personal','request','hash','{}')");
    await assert.rejects(client.query("INSERT INTO asset_ai_batches(\"userId\",\"scopeKey\",\"requestId\",\"payloadHash\",\"resultJson\") VALUES ('owner','personal','request','other','{}')"),/duplicate key/);
  } finally {
    await client.query("ROLLBACK").catch(()=>{});
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await client.end();
  }
});
