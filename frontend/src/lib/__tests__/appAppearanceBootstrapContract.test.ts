import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
const runtime = readFileSync(resolve(process.cwd(), "src/lib/runtimeCompatibility.ts"), "utf8");
const useSkin = readFileSync(resolve(process.cwd(), "src/hooks/useSkin.ts"), "utf8");
const settings = readFileSync(resolve(process.cwd(), "src/components/SettingsModal.tsx"), "utf8");

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

  it("keeps Settings on the whole-app appearance model without restoring note-theme UI", () => {
    expect(settings).toContain("<SkinSwitcher />");
    expect(settings).toContain("<ThemeToggle />");
    expect(settings).not.toContain("NoteThemePicker");
  });
});
