import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("third-party image hosting retirement", () => {
  it("routes every new editor image through Nowen attachments", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/imageUploadService.ts"),
      "utf8",
    );

    expect(source).toContain("api.attachments.upload");
    expect(source).toContain("所有新图片都先成为 Nowen 附件");
    expect(source).not.toContain("api.imageHosting.upload");
    expect(source).not.toContain("/image-hosting/status");
    expect(source).not.toContain("fallbackToLocal");
  });

  it("keeps a safe migration path for legacy public URLs", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/settings/ImageHostingSettings.tsx"),
      "utf8",
    );

    expect(source).toContain("第三方图床已退役");
    expect(source).toContain("api.attachments.importRemoteImage");
    expect(source).toContain("legacy-image-hosting-migration");
    expect(source).toContain("api.updateNote");
    expect(source).toContain("api.imageHosting.deleteConfig");
    expect(source).not.toContain("api.imageHosting.saveConfig");
    expect(source).not.toContain("api.imageHosting.test");
  });
});
