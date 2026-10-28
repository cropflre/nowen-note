import assert from "node:assert/strict";
import test from "node:test";
import { imageAttachmentPath } from "../src/lib/attachment-image-url";

test("image link extensions follow the stored MIME, including JPEG and modern formats", () => {
  for (const [mime, ext] of [["image/jpeg", "jpg"], ["image/png", "png"], ["image/gif", "gif"], ["image/webp", "webp"], ["image/avif", "avif"], ["image/heic", "heic"]]) {
    assert.equal(imageAttachmentPath("image-id", mime), `/api/attachments/image-id/image.${ext}`);
  }
  assert.equal(imageAttachmentPath("image-id", "IMAGE/JPEG; charset=utf-8"), "/api/attachments/image-id/image.jpg");
  assert.equal(imageAttachmentPath("file-id", "application/pdf"), undefined);
});
