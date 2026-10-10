import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { backupErrorResponse, classifyBackupFailure } from "../src/lib/backup-error-response";
import { requestErrorTracing } from "../src/middleware/request-error";

test("backup restore validation errors are distinguishable from internal failures", () => {
  const missing = classifyBackupFailure(new Error("备份文件不存在"), "restore");
  assert.deepEqual(missing, {
    code: "BACKUP_NOT_FOUND", message: "备份文件不存在", status: 404, retryable: false,
  });
  const corrupt = classifyBackupFailure("备份 checksum 校验和错误", "restore");
  assert.equal(corrupt.status, 400);
  assert.equal(corrupt.code, "BACKUP_RESTORE_VALIDATION_FAILED");
  const internal = classifyBackupFailure("SELECT * FROM private_notes at /home/secret/notes.db", "restore");
  assert.equal(internal.status, 500);
  assert.equal(internal.retryable, false);
  assert.doesNotMatch(JSON.stringify(internal), /SELECT|private_notes|secret|notes\\.db/);
});

test("import failures classify invalid format without leaking archive entry contents", () => {
  const invalid = classifyBackupFailure(new Error("无效 ZIP 文件头 in /tmp/private.zip"), "import");
  assert.equal(invalid.code, "BACKUP_INVALID_FORMAT");
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(invalid.message, /private.zip/);
  const unknown = classifyBackupFailure(new Error("password=secret"), "import");
  assert.equal(unknown.code, "BACKUP_IMPORT_FAILED");
  assert.equal(unknown.status, 500);
  assert.doesNotMatch(JSON.stringify(unknown), /password=secret/);
});

test("backup failures return a copyable request ID while retaining legacy error field", async () => {
  const app = new Hono();
  app.use("*", requestErrorTracing);
  app.get("/", (c) => backupErrorResponse(c, classifyBackupFailure(new Error("disk full"), "restore")));
  const res = await app.request("/", { headers: { "X-Request-Id": "request_123456789" } });
  const body = await res.json() as { error: string; code: string; requestId: string; retryable: boolean };
  assert.equal(res.status, 500);
  assert.equal(body.requestId, "request_123456789");
  assert.equal(body.code, "BACKUP_RESTORE_FAILED");
  assert.equal(body.retryable, false);
  assert.ok(body.error);
});
