import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("about QQ 群反馈入口", () => {
  it("展示群号、二维码预览入口及双语文案", () => {
    const settings = source("../../components/SettingsModal.tsx");
    const zh = source("../../i18n/locales/zh-CN.json");
    const en = source("../../i18n/locales/en.json");

    expect(settings).toContain('import qqGroupQr from "@/assets/feedback/qq-group.jpg"');
    expect(settings).toContain('const feedbackQqGroupNumber = "1093473044"');
    expect(settings).toContain("setFeedbackQqPreviewOpen(true)");
    expect(settings).toContain("src={qqGroupQr}");
    expect(settings).toContain("about.feedbackQqGroup");
    expect(settings).toContain("about.feedbackQqGroupNumber");
    expect(zh).toContain('"feedbackQqGroup": "加入 QQ 群反馈"');
    expect(en).toContain('"feedbackQqGroup": "Join the QQ feedback group"');
  });

  it("随前端构建携带 QQ 群二维码", () => {
    const image = readFileSync(path.join(process.cwd(), "src", "assets", "feedback", "qq-group.jpg"));
    expect(image.byteLength).toBeGreaterThan(0);
  });
});
