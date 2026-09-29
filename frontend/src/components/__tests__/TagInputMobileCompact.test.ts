import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.resolve(__dirname, "../TagInput.tsx"), "utf8");

describe("TagInput mobile compact metadata", () => {
  it("limits collapsed mobile metadata to three visible tags", () => {
    expect(source).toContain("noteTags.slice(0, 3)");
    expect(source).toContain("hiddenTagCount");
    expect(source).toContain("+{hiddenTagCount}");
  });

  it("keeps compact behavior below the sm breakpoint only", () => {
    expect(source).toContain('window.matchMedia("(max-width: 639px)")');
    expect(source).toContain("mobileCompact && isCompactViewport && !isFocused");
  });

  it("expands into the full tag editor on demand", () => {
    expect(source).toContain("expandCompactEditor");
    expect(source).toContain("inputRef.current?.focus()");
    expect(source).toContain("!compactCollapsed && (");
  });
});
