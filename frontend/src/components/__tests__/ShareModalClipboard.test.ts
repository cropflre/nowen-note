import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { enCoverageTranslations, zhCNCoverageTranslations } from "@/i18n/coverageTranslations";

const source = readFileSync(resolve(process.cwd(), "src/components/ShareModal.tsx"), "utf8");

describe("ShareModal clipboard fallback", () => {
  it("uses the shared clipboard helper instead of the Edge-sensitive direct API", () => {
    expect(source).toContain('import { copyText } from "@/lib/clipboard";');
    expect(source).toContain("const ok = await copyText(value);");
    expect(source).toContain('toast.error(t("shareUi.copyFailed"))');
    expect(zhCNCoverageTranslations.shareUi.copyFailed).toBe("复制失败，请手动复制");
    expect(enCoverageTranslations.shareUi.copyFailed).toBe("Copy failed. Please copy manually");
    expect(source).not.toContain("navigator.clipboard.writeText(value)");
  });

  it("only clears the copied indicator for the same share", () => {
    expect(source).toContain("setCopied((current) => current === id ? null : current)");
  });
});
