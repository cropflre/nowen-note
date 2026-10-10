import { describe, expect, it } from "vitest";
import {
  getCodeBlockAuthoringLanguages,
  getCodeBlockLanguageDisplayLabel,
  isKnownCodeBlockLanguage,
  normalizeCodeBlockLanguageId,
} from "@/lib/codeBlockLanguageRegistry";

describe("shared code block language registry", () => {
  it("normalizes authoring aliases used by Markdown and rich-text labels", () => {
    expect(normalizeCodeBlockLanguageId("JS")).toBe("javascript");
    expect(normalizeCodeBlockLanguageId("ts")).toBe("typescript");
    expect(normalizeCodeBlockLanguageId("shell")).toBe("bash");
    expect(normalizeCodeBlockLanguageId("MS")).toBe("maxscript");
    expect(normalizeCodeBlockLanguageId("mcr")).toBe("maxscript");
  });

  it("keeps product labels consistent for canonical and alias ids", () => {
    expect(getCodeBlockLanguageDisplayLabel("javascript")).toBe("JavaScript");
    expect(getCodeBlockLanguageDisplayLabel("js")).toBe("JavaScript");
    expect(getCodeBlockLanguageDisplayLabel("maxscript")).toBe("MAXScript");
    expect(getCodeBlockLanguageDisplayLabel("MS")).toBe("MAXScript");
    expect(getCodeBlockLanguageDisplayLabel("unknown-dsl")).toBe("unknown-dsl");
  });

  it("derives Markdown authoring completions from the shared popular language surface", () => {
    const languages = getCodeBlockAuthoringLanguages();
    expect(languages).toEqual(expect.arrayContaining([
      "javascript", "typescript", "bash", "python", "json", "yaml",
      "kotlin", "swift", "maxscript", "markdown", "text",
    ]));
    expect(languages).not.toContain("auto");
    expect(isKnownCodeBlockLanguage("js")).toBe(true);
    expect(isKnownCodeBlockLanguage("maxscript")).toBe(true);
    expect(isKnownCodeBlockLanguage("unknown-dsl")).toBe(false);
  });
});
