import { describe, expect, it } from "vitest";
import {
  buildExistingAttachmentMarkdownSnippet,
  isInlineImageAttachment,
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

  it("builds Markdown image syntax for images", () => {
    expect(buildExistingAttachmentMarkdownSnippet(fileItem({
      category: "image",
      filename: "不再犹豫].jpg",
      mimeType: "image/jpeg",
      size: 1_572_864,
      url: "/api/attachments/image id)",
    }))).toBe("![不再犹豫\\].jpg](/api/attachments/image%20id%29)");
  });

  it("keeps non-image files as attachment links with size", () => {
    expect(buildExistingAttachmentMarkdownSnippet(fileItem())).toBe(
      "[📎 document.pdf (1.5 KB)](/api/attachments/file-id)",
    );
  });
});
