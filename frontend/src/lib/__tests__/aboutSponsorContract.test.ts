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
    expect(settings).toContain('import wechatSponsorQr from "@/assets/sponsor/weixin.jpg"');
    expect(settings).toContain('import alipaySponsorQr from "@/assets/sponsor/zhifubao.png"');
    expect(settings).toContain('sponsorMethod === "wechat" ? wechatSponsorQr : alipaySponsorQr');
    expect(settings).not.toContain('src="/weixin.jpg"');
    expect(settings).not.toContain('src="/zhifubao.png"');
    expect(zh).toContain('"sponsorAlipay": "支付宝"');
    expect(en).toContain('"sponsorAlipay": "Alipay"');
  });

  it("ships sponsor images as Vite-managed source assets", () => {
    const wechatImage = readFileSync(path.join(process.cwd(), "src", "assets", "sponsor", "weixin.jpg"));
    const alipayImage = readFileSync(path.join(process.cwd(), "src", "assets", "sponsor", "zhifubao.png"));
    expect(wechatImage.byteLength).toBeGreaterThan(0);
    expect(alipayImage.byteLength).toBeGreaterThan(0);
  });
});
