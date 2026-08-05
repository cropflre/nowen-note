import { describe, expect, it } from "vitest";
import {
  buildExistingAttachmentMarkdownSnippet,
  isInlineImageAttachment,
  isInlineVideoAttachment,
  type ExistingAttachmentInsertItem,
} from "@/lib/existingAttachmentInsert";

function fileItem(overrides: Partial<ExistingAttachmentInsertItem> = {}): ExistingAttachmentInsertItem {
  return {
    category: "file",
    filename: "document.pdf",
    mimeType: "application/pdf",
    size: 1536,
    url: "/api/attachments/file-id",
    ...overrides,
  };
}

describe("existing attachment insertion", () => {
  it("recognizes images by category and MIME fallback", () => {
    expect(isInlineImageAttachment(fileItem({ category: "image" }))).toBe(true);
    expect(isInlineImageAttachment(fileItem({ mimeType: "image/jpeg" }))).toBe(true);
    expect(isInlineImageAttachment(fileItem())).toBe(false);
  });

  it("recognizes videos by MIME and extension fallback", () => {
    expect(isInlineVideoAttachment(fileItem({ filename: "clip.bin", mimeType: "video/mp4" }))).toBe(true);
    expect(isInlineVideoAttachment(fileItem({ filename: "clip.webm", mimeType: "application/octet-stream" }))).toBe(true);
    expect(isInlineVideoAttachment(fileItem())).toBe(false);
  });

  it("builds Markdown image syntax for images", () => {
    expect(buildExistingAttachmentMarkdownSnippet(fileItem({
      category: "image",
      filename: "不再犹豫].jpg",
      mimeType: "image/jpeg",
      size: 1_572_864,
      url: "/api/attachments/image id)",
    }))).toBe("![不再犹豫\\].jpg](/api/attachments/image%20id%29)");
  });

  it("builds playable Markdown video syntax for videos", () => {
    expect(buildExistingAttachmentMarkdownSnippet(fileItem({
      filename: '演示 "终稿".mp4',
      mimeType: "video/mp4",
      size: 8_388_608,
      url: "/api/attachments/video id)",
    }))).toBe('\n\n@[video](/api/attachments/video%20id%29?inline=1 "演示 \\"终稿\\".mp4")\n\n');
  });

  it("keeps non-media files as attachment links with size", () => {
    expect(buildExistingAttachmentMarkdownSnippet(fileItem())).toBe(
      "[📎 document.pdf (1.5 KB)](/api/attachments/file-id)",
    );
  });
});
