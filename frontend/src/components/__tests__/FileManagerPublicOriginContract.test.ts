import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(path.resolve(__dirname, relative), "utf8");
}

describe("File Manager public-origin contract", () => {
  it("routes copied URL/Markdown/HTML through the public attachment builder", () => {
    const source = read("../FileManager.tsx");
    expect(source).toContain("buildPublicAttachmentUrl(resolved, publicAttachmentOptions)");
    expect(source).toContain("formatImageHostSnippet(format, full, item.filename)");
    expect(source).toContain("siteConfig.filePublicOrigin");
    expect(source).toContain("siteConfig.publicWebOrigin");
  });

  it("keeps owner downloads on the current resolved attachment URL", () => {
    const source = read("../FileManager.tsx");
    expect(source).toContain("downloadAttachment(resolveAttachmentUrl(item.url)");
    expect(source).not.toContain("downloadAttachment(buildPublicAttachmentUrl");
  });

  it("uses the same public URL builder in the attachment share drawer", () => {
    const source = read("../attachmentDetail/AttachmentDetailDrawer.tsx");
    expect(source).toContain("buildPublicAttachmentUrl(");
    expect(source).toContain("filePublicOrigin: siteConfig.filePublicOrigin");
    expect(source).toContain("publicWebOrigin: siteConfig.publicWebOrigin");
    expect(source).toContain("href={resolveAttachmentUrl(detail.url)}");
  });

  it("exposes an admin-editable file public origin with inheritance copy", () => {
    const source = read("../FileManager.tsx");
    expect(source).toContain("data-file-public-origin");
    expect(source).toContain("updateFilePublicOrigin");
    expect(source).toContain("继承公开分享地址");
    expect(source).toContain("/api/attachments/*");
  });
});
