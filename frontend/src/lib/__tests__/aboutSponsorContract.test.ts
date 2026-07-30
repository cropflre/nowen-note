import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("about sponsor contract", () => {
  it("offers WeChat and Alipay as explicit sponsor methods", () => {
    const settings = source("../../components/SettingsModal.tsx");
    const zh = source("../../i18n/locales/zh-CN.json");
    const en = source("../../i18n/locales/en.json");

    expect(settings).toContain('useState<"wechat" | "alipay">("wechat")');
    expect(settings).toContain("about.sponsorWechat");
    expect(settings).toContain("about.sponsorAlipay");
    expect(settings).toContain('sponsorMethod === "wechat" ? "/weixin.jpg" : "/zhifubao.png"');
    expect(zh).toContain('"sponsorAlipay": "支付宝"');
    expect(en).toContain('"sponsorAlipay": "Alipay"');
  });

  it("ships the Alipay reward image with the frontend public assets", () => {
    const image = readFileSync(path.join(process.cwd(), "public", "zhifubao.png"));
    expect(image.byteLength).toBeGreaterThan(0);
  });
});
