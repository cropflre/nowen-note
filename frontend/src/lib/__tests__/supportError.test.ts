import { describe, expect, it } from "vitest";
import { formatSupportError, formatSupportReference } from "../supportError";

describe("backup support reference formatting", () => {
  it("prefers server requestId and allows copying the safe code and ID", () => {
    const error = Object.assign(new Error("备份恢复失败"), {
      code: "BACKUP_RESTORE_FAILED", requestId: "request_123456789",
      operationId: "job_123456789",
    });
    const support = formatSupportError(error, "fallback");
    expect(support).toEqual({
      message: "备份恢复失败", code: "BACKUP_RESTORE_FAILED",
      reference: "request_123456789", referenceKind: "requestId",
    });
    expect(formatSupportReference(support)).toBe("BACKUP_RESTORE_FAILED · request_123456789");
  });

  it("keeps backup async job ID if no request ID was provided", () => {
    const support = formatSupportError({
      code: "BACKUP_STORAGE_NO_SPACE", message: "磁盘空间不足", operationId: "job_123456789",
    }, "fallback");
    expect(support.reference).toBe("job_123456789");
  });

  it("does not trust remote messages even when the error code looks valid", () => {
    const issue = formatSupportError({
      code: "BACKUP_CREATE_FAILED",
      message: "password=secret /srv/private/notes.db",
      requestId: "request_123456789",
    }, "操作失败");
    expect(issue).toEqual({
      code: "BACKUP_CREATE_FAILED",
      message: "备份创建失败",
      reference: "request_123456789",
      referenceKind: "requestId",
    });
    expect(JSON.stringify(issue)).not.toMatch(/password|secret|private|notes\\.db/);
  });

  it("does not echo arbitrary server exceptions, unsafe request IDs or paths", () => {
    const support = formatSupportError(new Error("database at /private/path/secret.db"), "操作失败");
    expect(support.message).toBe("操作失败");
    expect(formatSupportReference(support)).toBeNull();
    const invalid = formatSupportError({
      code: "bad-code", message: "/data/private", requestId: "id\nleak",
    }, "操作失败");
    expect(invalid).toEqual({ message: "操作失败" });
  });
});
