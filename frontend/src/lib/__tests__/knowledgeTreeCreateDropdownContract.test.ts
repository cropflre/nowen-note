import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("knowledge tree create dropdown contract", () => {
  it("uses an anchored menu instead of the global confirm dialog", () => {
    const runtime = source("../../components/KnowledgeTreeCreateMenuRuntime.tsx");

    expect(runtime).toContain('role="menu"');
    expect(runtime).toContain("createPortal(");
    expect(runtime).toContain('label: "富文本文档"');
    expect(runtime).toContain('label: "Markdown 文档"');
    expect(runtime).toContain('label: "文件夹"');
    expect(runtime).not.toContain("choose({");
    expect(runtime).not.toContain("prompt({");
  });

  it("anchors both the root and row plus buttons to the same menu", () => {
    const runtime = source("../../components/KnowledgeTreeCreateMenuRuntime.tsx");

    expect(runtime).toContain('button.setAttribute(CREATE_SCOPE_ATTR, "root")');
    expect(runtime).toContain('button.setAttribute(CREATE_SCOPE_ATTR, "node")');
    expect(runtime).toContain('button.setAttribute("aria-haspopup", "menu")');
    expect(runtime).toContain("button.getBoundingClientRect()");
  });
});
