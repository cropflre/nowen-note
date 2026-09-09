import assert from "node:assert/strict";
import test from "node:test";
import {
  getTaskAttachmentExtension,
  getTaskAttachmentMaxSizeBytes,
  isBlockedTaskAttachment,
  shouldInlineTaskAttachment,
} from "../src/lib/task-attachment-policy";

test("task attachment size follows MAX_ATTACHMENT_SIZE_MB", () => {
  const previous = process.env.MAX_ATTACHMENT_SIZE_MB;
  try {
    delete process.env.MAX_ATTACHMENT_SIZE_MB;
    assert.equal(getTaskAttachmentMaxSizeBytes(), 100 * 1024 * 1024);

    process.env.MAX_ATTACHMENT_SIZE_MB = "512";
    assert.equal(getTaskAttachmentMaxSizeBytes(), 512 * 1024 * 1024);

    process.env.MAX_ATTACHMENT_SIZE_MB = "20000";
    assert.equal(getTaskAttachmentMaxSizeBytes(), 100 * 1024 * 1024);
  } finally {
    if (previous === undefined) delete process.env.MAX_ATTACHMENT_SIZE_MB;
    else process.env.MAX_ATTACHMENT_SIZE_MB = previous;
  }
});

test("generic office and pdf files are accepted while executables and scripts are blocked", () => {
  assert.equal(isBlockedTaskAttachment("工作手机清单.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), false);
  assert.equal(isBlockedTaskAttachment("需求.pdf", "application/pdf"), false);
  assert.equal(isBlockedTaskAttachment("notes.txt", "text/plain"), false);

  assert.equal(isBlockedTaskAttachment("payload.exe", "application/octet-stream"), true);
  assert.equal(isBlockedTaskAttachment("install.bat", "text/plain"), true);
  assert.equal(isBlockedTaskAttachment("run.sh", "text/plain"), true);
});

test("extension fallback preserves safe original extensions", () => {
  assert.equal(
    getTaskAttachmentExtension(
      "工作手机清单.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    "xlsx",
  );
  assert.equal(getTaskAttachmentExtension("archive.custom", "application/octet-stream"), "custom");
  assert.equal(getTaskAttachmentExtension("no-extension", "application/octet-stream"), "bin");
});

test("only browser-safe task attachment types are inline previewed", () => {
  assert.equal(shouldInlineTaskAttachment("image/png"), true);
  assert.equal(shouldInlineTaskAttachment("application/pdf"), true);
  assert.equal(shouldInlineTaskAttachment("video/mp4"), true);
  assert.equal(shouldInlineTaskAttachment("audio/mpeg"), true);
  assert.equal(shouldInlineTaskAttachment("text/plain"), true);
  assert.equal(
    shouldInlineTaskAttachment("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    false,
  );
  assert.equal(shouldInlineTaskAttachment("application/zip"), false);
});
