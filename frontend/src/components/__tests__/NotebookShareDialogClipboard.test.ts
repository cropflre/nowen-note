import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.resolve(__dirname, "../NotebookShareDialog.tsx"), "utf8");

describe("NotebookShareDialog clipboard compatibility", () => {
  it("uses the shared HTTP-compatible clipboard fallback", () => {
    expect(source).toContain('import { copyText } from "@/lib/clipboard";');
    expect(source).toContain("const copied = await copyText(value);");
    expect(source).not.toContain("navigator.clipboard.writeText");
  });
});
