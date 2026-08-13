import assert from "node:assert/strict";
import test from "node:test";

import {
  TransientPersistedImageSourceError,
  stabilizePersistedNoteContent,
} from "../src/lib/noteContentAttachmentIdentity";

const ATTACHMENT_ID = "123e4567-e89b-42d3-a456-426614174216";

test("Tiptap 附件签名地址落库前恢复为稳定身份", () => {
  const content = JSON.stringify({
    type: "doc",
    content: [{
      type: "image",
      attrs: {
        src: `https://notes.example.com/api/attachments/${ATTACHMENT_ID}?exp=1&sig=temporary`,
      },
    }],
  });

  const result = stabilizePersistedNoteContent(content, "tiptap-json");
  assert.equal(JSON.parse(result).content[0].attrs.src, `/api/attachments/${ATTACHMENT_ID}`);
});

test("无法恢复身份的 Tiptap blob 图片拒绝覆盖已有正文", () => {
  const content = JSON.stringify({
    type: "doc",
    content: [{ type: "image", attrs: { src: "blob:file:///expired" } }],
  });

  assert.throws(
    () => stabilizePersistedNoteContent(content, "tiptap-json"),
    TransientPersistedImageSourceError,
  );
});

test("Markdown 图片遵循相同持久化规则", () => {
  const signed = `https://notes.example.com/api/attachments/${ATTACHMENT_ID}?exp=1&sig=temporary`;
  assert.equal(
    stabilizePersistedNoteContent(`![image](${signed})`, "markdown"),
    `![image](/api/attachments/${ATTACHMENT_ID})`,
  );
  assert.throws(
    () => stabilizePersistedNoteContent("![image](blob:file:///expired)", "markdown"),
    TransientPersistedImageSourceError,
  );
});
