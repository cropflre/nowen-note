import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve(__dirname, "../AndroidShareImportCenter.tsx"),
  "utf8",
);

describe("AndroidShareImportCenter", () => {
  it("keeps footer actions above the native Android navigation bar", () => {
    expect(source).toContain(
      'style={{ paddingBottom: "max(0.75rem, var(--safe-area-bottom, 0px))" }}',
    );
    expect(source).not.toContain("env(safe-area-inset-bottom)");
  });
});
