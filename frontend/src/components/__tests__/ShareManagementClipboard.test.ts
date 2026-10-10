import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/components/ShareManagementPage.tsx"), "utf8");

describe("ShareManagementPage clipboard fallback", () => {
  it("uses the shared clipboard helper for share links and public origins", () => {
    expect(source).toContain('import { copyText } from "@/lib/clipboard";');
    expect(source).toContain("const ok = await copyText(publicOrigin.origin);");
    expect(source).toContain("const ok = await copyText(shareUrl(item));");
    expect(source).not.toContain("navigator.clipboard.writeText");
  });

  it("keeps the manual-copy error when both clipboard strategies fail", () => {
    expect(source).toContain('toast.error("复制失败，请手动复制")');
  });
});
