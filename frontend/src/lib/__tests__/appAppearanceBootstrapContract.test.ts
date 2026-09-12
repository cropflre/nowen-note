import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(new URL("../../main.tsx", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../runtimeCompatibility.ts", import.meta.url), "utf8");
const useSkin = readFileSync(new URL("../../hooks/useSkin.ts", import.meta.url), "utf8");

describe("app appearance bootstrap contract", () => {
  it("boots whole-app appearance from the first main entry import", () => {
    expect(main.trimStart().startsWith('import "./lib/runtimeCompatibility";')).toBe(true);
    expect(runtime).toContain('import "../app-appearance.css";');
    expect(runtime).toContain('import "../app-appearance-neutral-compat.css";');
    expect(runtime).toContain("bootstrapAppAppearanceRuntime();");
    expect(runtime).toContain("installLegacyNoteAppearanceNeutralizer();");
    expect(runtime).toContain("installEditorFontAppearanceGuard();");
  });

  it("keeps SkinSwitcher/useSkin as interaction state instead of runtime infrastructure", () => {
    expect(useSkin).not.toContain("bootstrapAppAppearanceRuntime");
    expect(useSkin).not.toContain("installLegacyNoteAppearanceNeutralizer");
    expect(useSkin).not.toContain('import "@/app-appearance.css"');
  });
});
