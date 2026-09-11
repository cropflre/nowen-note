import { describe, expect, it } from "vitest";
import {
  DEFAULT_ATTACHMENT_LIMIT_BYTES,
  formatAttachmentLimit,
  validateAttachmentSize,
  type AttachmentUploadPolicy,
} from "@/lib/attachmentUploadPolicy";

function serverPolicy(maxAttachmentSizeBytes: number): AttachmentUploadPolicy {
  return { maxAttachmentSizeBytes, authoritative: true, source: "server" };
}

describe("attachment upload policy", () => {
  it("keeps 99 MiB and exactly 100 MiB valid under the default server contract", () => {
    const policy = serverPolicy(DEFAULT_ATTACHMENT_LIMIT_BYTES);
    expect(validateAttachmentSize(99 * 1024 * 1024, policy).ok).toBe(true);
    expect(validateAttachmentSize(100 * 1024 * 1024, policy).ok).toBe(true);
  });

  it("rejects 100 MiB + 1 byte with exact max/actual metadata", () => {
    const policy = serverPolicy(DEFAULT_ATTACHMENT_LIMIT_BYTES);
    const actual = 100 * 1024 * 1024 + 1;
    const result = validateAttachmentSize(actual, policy);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected size rejection");
    expect(result.maxSizeBytes).toBe(DEFAULT_ATTACHMENT_LIMIT_BYTES);
    expect(result.actualSizeBytes).toBe(actual);
    expect(result.message).toContain("100 MiB");
  });

  it("honors a 500 MiB runtime server configuration without rebuilding frontend", () => {
    const policy = serverPolicy(500 * 1024 * 1024);
    expect(validateAttachmentSize(499 * 1024 * 1024, policy).ok).toBe(true);
    expect(validateAttachmentSize(500 * 1024 * 1024, policy).ok).toBe(true);
    expect(validateAttachmentSize(500 * 1024 * 1024 + 1, policy).ok).toBe(false);
  });

  it("does not falsely reject when policy discovery is unavailable", () => {
    const fallback: AttachmentUploadPolicy = {
      maxAttachmentSizeBytes: DEFAULT_ATTACHMENT_LIMIT_BYTES,
      authoritative: false,
      source: "fallback",
    };
    expect(validateAttachmentSize(500 * 1024 * 1024, fallback).ok).toBe(true);
  });

  it("formats MiB and GiB limits consistently", () => {
    expect(formatAttachmentLimit(100 * 1024 * 1024)).toBe("100 MiB");
    expect(formatAttachmentLimit(2 * 1024 * 1024 * 1024)).toBe("2 GiB");
  });
});
