import assert from "node:assert/strict";
import test from "node:test";
import { buildFolderSyncAttachmentBaseContent } from "../src/lib/folderSyncAttachmentContent";

test("folder sync attachment notes include a persistent attachment link", () => {
  const content = buildFolderSyncAttachmentBaseContent({
    title: "扫描件",
    filename: "扫描件.pdf",
    relativePath: "资料/扫描件.pdf",
    sha256: "a".repeat(64),
    attachmentId: "11111111-1111-4111-8111-111111111111",
  });

  assert.match(content, /^# 扫描件/m);
  assert.match(content, /\[📎 扫描件\.pdf\]\(\/api\/attachments\/11111111-1111-4111-8111-111111111111\)/);
  assert.match(content, /- 相对路径：资料\/扫描件\.pdf/);
});
