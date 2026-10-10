import assert from "node:assert/strict";
import test from "node:test";
import { classifyAttachmentStorageError } from "../src/services/attachment-storage";

function errno(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test("attachment storage errors expose stable machine-readable categories", () => {
  assert.equal(
    classifyAttachmentStorageError(errno("EACCES", "permission denied")).code,
    "ATTACHMENT_STORAGE_PERMISSION_DENIED",
  );
  assert.equal(
    classifyAttachmentStorageError(errno("EROFS", "read-only filesystem")).code,
    "ATTACHMENT_STORAGE_PERMISSION_DENIED",
  );
  assert.equal(
    classifyAttachmentStorageError(errno("ENOSPC", "no space left")).code,
    "ATTACHMENT_STORAGE_NO_SPACE",
  );
  assert.equal(
    classifyAttachmentStorageError(new Error("S3 PUT failed: 403 AccessDenied")).code,
    "ATTACHMENT_STORAGE_CONFIG_INVALID",
  );
  assert.equal(
    classifyAttachmentStorageError(new Error("generic write failure")).code,
    "ATTACHMENT_STORAGE_NOT_WRITABLE",
  );
});
