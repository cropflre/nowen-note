import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  attachmentWriteErrorResponse, classifyAttachmentWriteFailure,
} from "../src/lib/attachment-error-response";
import { requestErrorTracing } from "../src/middleware/request-error";

test("file system failures have safe, stable codes, never raw paths or secrets", () => {
  const noSpace = Object.assign(new Error("ENOSPC /private/mount/secret"), { code: "ENOSPC" });
  const classified = classifyAttachmentWriteFailure("storage", noSpace);
  assert.equal(classified.code, "ATTACHMENT_STORAGE_NO_SPACE");
  assert.equal(classified.retryable, false);
  assert.match(classified.error, /存储空间不足/);
  assert.doesNotMatch(JSON.stringify(classified), /private|secret/);

  const denied = classifyAttachmentWriteFailure("repair-storage", Object.assign(new Error("/srv/user"), { code: "EACCES" }));
  assert.equal(denied.code, "ATTACHMENT_STORAGE_PERMISSION_DENIED");
  assert.doesNotMatch(JSON.stringify(denied), /srv|user/);
});

test("upload and repair DB failures preserve legacy code without SQL exposure", () => {
  const injected = new Error("SQLITE_CONSTRAINT: SELECT password FROM users at /data/nowen.db");
  const write = classifyAttachmentWriteFailure("database", injected);
  assert.equal(write.code, "ATTACHMENT_DB_WRITE_FAILED");
  assert.match(write.error, /写入数据库失败/);
  assert.doesNotMatch(JSON.stringify(write), /password|SELECT|nowen.db/);
  const repair = classifyAttachmentWriteFailure("repair-database", injected);
  assert.equal(repair.code, "ATTACHMENT_DB_WRITE_FAILED");
  assert.match(repair.error, /更新附件元数据失败/);
  assert.equal(classifyAttachmentWriteFailure("read", injected).code, "ATTACHMENT_READ_FAILED");
});

test("attachment API failures expose a correlation ID and keep old error/code keys", async () => {
  const app = new Hono();
  app.use("*", requestErrorTracing);
  app.post("/upload", (c) => attachmentWriteErrorResponse(
    c, "database", new Error("SELECT /private/user.db"),
  ));
  const response = await app.request("/upload", {
    method: "POST", headers: { "X-Request-Id": "request_123456789" },
  });
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 500);
  assert.deepEqual(body, {
    error: "写入数据库失败，请根据故障编号检查服务端日志",
    code: "ATTACHMENT_DB_WRITE_FAILED",
    requestId: "request_123456789",
    retryable: false,
  });
  assert.equal(response.headers.get("X-Request-Id"), "request_123456789");
});
