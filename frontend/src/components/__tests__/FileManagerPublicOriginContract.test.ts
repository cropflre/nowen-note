import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { zhCNFileExplorerTranslations } from "@/i18n/fileExplorerTranslations";

function read(relative: string): string {
  return readFileSync(path.resolve(__dirname, relative), "utf8");
}

// The former standalone image-host page now lives in the file page's Image hosting view.
describe("File page public-origin contract", () => {
  it("copies URL/Markdown/HTML only from the server-issued public link", () => {
    const explorer = read("../fileExplorer/FileExplorer.tsx");
    expect(explorer).toContain("await createStableFileShareUrl(file.id)");
    expect(explorer).toContain("formatImageHostSnippet(format, url, file.filename)");
    const host = read("../fileExplorer/ImageHostView.tsx");
    expect(host).toContain('const FORMATS: ImageHostFormat[] = ["url", "markdown", "html"]');
  });

  it("keeps owner downloads on the current resolved attachment URL", () => {
    const explorer = read("../fileExplorer/FileExplorer.tsx");
    expect(explorer).toContain("downloadAttachment(resolveAttachmentUrl(file.url)");
    expect(explorer).not.toContain("downloadAttachment(buildPublicAttachmentUrl");
  });

  it("shows and copies only the server-issued link in the attachment share drawer", () => {
    const source = read("../attachmentDetail/AttachmentDetailDrawer.tsx");
    expect(source).toContain("await createStableFileShareUrl(currentId)");
    expect(source).toContain("formatImageHostSnippet(format, url, filename)");
    // The 12-hour runtime URL must never be displayed as the share link.
    expect(source).not.toContain("buildPublicAttachmentUrl(");
    expect(source).toContain("value={publicLink}");
    expect(source).toContain("href={resolveAttachmentUrl(detail.url)}");
  });

  it("exposes an admin-editable file public origin with inheritance copy", () => {
    const source = read("../fileExplorer/ImageHostView.tsx");
    expect(source).toContain("data-file-public-origin");
    expect(source).toContain("updateFilePublicOrigin");
    expect(source).toContain("filePublicOrigin: siteConfig.filePublicOrigin, publicWebOrigin: siteConfig.publicWebOrigin");
    expect(source).toContain('user?.role === "admin"');
    const copy = zhCNFileExplorerTranslations.fileExplorer.imageHost;
    expect(copy.originSource.inherit).toBe("继承公开分享地址");
    expect(copy.originHelp).toContain("/api/attachments/*");
  });
});
