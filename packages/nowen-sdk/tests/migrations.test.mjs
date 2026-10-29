import test from "node:test";
import assert from "node:assert/strict";
import { NowenClient } from "../dist/index.js";

test("migration SDK shares the REST contract, streams Blob bytes and uses the current preview digest", async () => {
  const calls = [];
  const job = { id: "job/one", status: "CREATED", counts: { total: 0 } };
  const client = new NowenClient({ baseUrl: "https://nowen.example", fetch: async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(job), { headers: { "Content-Type": "application/json" } });
  } });
  client.setToken("nkn_test");
  await client.createMigration({ operationId: "retry-key-001", source: { platform: "markdown", exportId: "export-1" } });
  assert.equal(calls.at(-1).url, "https://nowen.example/api/migrations");
  assert.equal(JSON.parse(calls.at(-1).init.body).operationId, "retry-key-001");
  await client.stageMigrationItems(job.id, [{ schemaVersion: 1, source: { platform: "markdown", exportId: "export-1", sourceId: "note-1" },
    title: "Note", contentFormat: "markdown", content: "# Body" }]);
  assert.ok(calls.at(-1).url.endsWith("/job%2Fone/items"));
  assert.equal(JSON.parse(calls.at(-1).init.body).items[0].content, "# Body");
  const file = new Blob(["# Body"], { type: "application/octet-stream" });
  await client.uploadMigrationFile(job.id, file, "笔记.md", { assetPath: "assets/image.png", sha256: "a".repeat(64) });
  assert.equal(calls.at(-1).init.body, file, "binary uploads must not JSON stringify the Blob");
  const uploadUrl = new URL(calls.at(-1).url);
  assert.equal(uploadUrl.searchParams.get("filename"), "笔记.md");
  assert.equal(uploadUrl.searchParams.get("assetPath"), "assets/image.png");
  const digest = "b".repeat(64);
  await client.approveMigration(job.id, digest);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { previewDigest: digest });
  await client.migrationReport(job.id, "page-2");
  assert.equal(new URL(calls.at(-1).url).searchParams.get("cursor"), "page-2");
  for (const action of ["retry", "cancel", "pause", "resume", "undo"]) {
    await client[`${action}Migration`](job.id);
    assert.equal(calls.at(-1).init.method, "POST");
    assert.ok(calls.at(-1).url.endsWith(`/${action}`));
    assert.equal(calls.at(-1).init.headers.Authorization, "Bearer nkn_test");
  }
});

test("server refusal of PAT approval remains a refusal and never falls back to login", async () => {
  const calls = [];
  const client = new NowenClient({ baseUrl: "https://nowen.example", fetch: async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ code: "HUMAN_APPROVAL_REQUIRED" }), { status: 403 });
  } });
  client.setToken("nkn_test");
  await assert.rejects(client.approveMigration("job-1", "a".repeat(64)), /403.*HUMAN_APPROVAL_REQUIRED/);
  assert.deepEqual(calls, ["https://nowen.example/api/migrations/job-1/approve"]);
});

test("SDK resumes upload sessions with raw chunk hashes and binds item choices to a preview", async () => {
  const calls = [];
  const client = new NowenClient({ baseUrl: "https://nowen.example", fetch: async (url, init) => {
    calls.push({ url: String(url), init }); return Response.json({ id: "upload-1", offset: 4 });
  } });
  client.setToken("nkn_fixture");
  await client.createMigrationUploadSession("job/1", { operationId: "same-operation", filename: "one.md", size: 4, sha256: "a".repeat(64) });
  assert.ok(calls.at(-1).url.endsWith("/job%2F1/upload-sessions"));
  const chunk = new Blob(["body"]);
  await client.putMigrationUploadChunk("job/1", "upload-1", 0, chunk, "b".repeat(64));
  assert.equal(calls.at(-1).init.body, chunk);
  assert.equal(calls.at(-1).init.headers["X-Chunk-SHA256"], "b".repeat(64));
  assert.ok(calls.at(-1).url.endsWith("/chunks?offset=0"));
  await client.getMigrationUploadSession("job/1", "upload-1");
  assert.equal(calls.at(-1).init.method, "GET");
  await client.completeMigrationUpload("job/1", "upload-1");
  assert.ok(calls.at(-1).url.endsWith("/upload-1/complete"));
  await client.decideMigrationItem("job/1", "item/1", "c".repeat(64), "create-copy");
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { previewDigest: "c".repeat(64), decision: "create-copy" });
  await client.cancelMigrationUpload("job/1", "upload-1");
  assert.equal(calls.at(-1).init.method, "DELETE");
});
