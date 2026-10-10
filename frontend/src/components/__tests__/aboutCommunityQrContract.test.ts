import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("about Nowen 开源实验室公众号入口", () => {
  it("展示二维码及双语文案", () => {
    const settings = source("../../components/SettingsModal.tsx");
    const zh = source("../../i18n/locales/zh-CN.json");
    const en = source("../../i18n/locales/en.json");

    expect(settings).toContain('import communityQr from "@/assets/community/nowen-lab-wechat.jpg"');
    expect(settings).toContain("src={communityQr}");
    expect(settings).toContain("about.communityQrTitle");
    expect(settings).toContain("about.communityQrDesc");
    expect(zh).toContain('"communityQrTitle": "Nowen 开源实验室"');
    expect(en).toContain('"communityQrTitle": "Nowen Open Source Lab"');
  });

  it("随前端构建携带公众号二维码", () => {
    const image = readFileSync(
      path.join(process.cwd(), "src", "assets", "community", "nowen-lab-wechat.jpg"),
    );
    expect(image.byteLength).toBeGreaterThan(0);
  });
});
