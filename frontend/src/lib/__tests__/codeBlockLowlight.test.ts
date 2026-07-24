import { describe, expect, it } from "vitest";
import {
  createCodeBlockLowlight,
  formatCodeBlockLanguageLabel,
} from "@/lib/codeBlockLowlight";

const SAMPLE = `-- Matrix3 example
fn buildTransform position rotation scaleValue =
(
  local transform = matrix3 1
  transform.rotation = rotation as quat
  transform.scale = [scaleValue, scaleValue, scaleValue]
  return transform
)

for obj in geometry where not obj.isHidden do
(
  format "node: %\\n" obj.name
)`;

describe("MAXScript lowlight language", () => {
  it("registers one canonical language and the ms/mcr aliases", () => {
    const lowlight = createCodeBlockLowlight();

    expect(lowlight.listLanguages()).toContain("maxscript");
    expect(lowlight.listLanguages()).not.toContain("ms");
    expect(lowlight.listLanguages()).not.toContain("mcr");
    expect(lowlight.registered("maxscript")).toBe(true);
    expect(lowlight.registered("ms")).toBe(true);
    expect(lowlight.registered("mcr")).toBe(true);
  });

  it.each(["maxscript", "ms", "mcr"])("highlights explicit %s fences", (language) => {
    const tree = createCodeBlockLowlight().highlight(language, SAMPLE);
    const serialized = JSON.stringify(tree);

    expect(serialized).toContain("hljs-comment");
    expect(serialized).toContain("hljs-keyword");
    expect(serialized).toContain("hljs-title");
    expect(serialized).toContain("hljs-built_in");
    expect(serialized).toContain("hljs-string");
    expect(serialized).toContain("hljs-number");
  });

  it("highlights MAXScript keywords and built-ins case-insensitively", () => {
    const explicit = JSON.stringify(
      createCodeBlockLowlight().highlight("maxscript", "FN Build = MATRIX3 1"),
    );

    expect(explicit).toContain("hljs-keyword");
    expect(explicit).toContain("hljs-built_in");
  });

  it("stays out of automatic detection", () => {
    expect(createCodeBlockLowlight().highlightAuto(SAMPLE).data?.language).not.toBe("maxscript");
  });

  it("uses the product label for canonical and alias identifiers", () => {
    expect(formatCodeBlockLanguageLabel("maxscript")).toBe("MAXScript");
    expect(formatCodeBlockLanguageLabel("MS")).toBe("MAXScript");
    expect(formatCodeBlockLanguageLabel("mcr")).toBe("MAXScript");
  });
});
