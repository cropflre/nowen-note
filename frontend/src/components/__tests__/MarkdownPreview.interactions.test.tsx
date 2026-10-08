import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback || _key }),
}));

import { MarkdownPreview } from "@/components/MarkdownPreview";

describe("MarkdownPreview interactions", () => {
  it("renders interactive task lists without a duplicate bullet", () => {
    const output = renderToStaticMarkup(
      <MarkdownPreview markdown={"- [ ] pending\n- [x] done"} onTaskCheckboxChange={() => {}} />,
    );

    expect(output).toContain('type="checkbox"');
    expect(output).not.toContain("disabled");
    expect(output).toContain("list-none");
    expect(output).toContain("task-list-item");
  });

  it("marks each GFM task and renders isolated text for checked and nested items", () => {
    const source = "- [x] finished **bold**\n- [ ] pending\n  - [x] completed child";
    const output = renderToStaticMarkup(<MarkdownPreview markdown={source} />);
    expect(source).toContain("- [x] finished");
    expect(output).toContain('data-checked="true"');
    expect(output).toContain('data-checked="false"');
    expect(output).toContain('class="nowen-task-item-text');
    expect(output).toMatch(/data-checked="true"[^>]*>[\\s\\S]*?nowen-task-item-text/);
    expect((output.match(/class="nowen-task-item-text/g) || []).length).toBe(3);
    // The nested child must be rendered outside its parent's decorated text span.
    expect(output).toMatch(/pending<\\/span>[\\s\\S]*?<ul/);
  });

  it("keeps ordinary unordered lists styled with bullets", () => {
    const output = renderToStaticMarkup(<MarkdownPreview markdown={"- alpha\n- beta"} />);
    expect(output).toContain("list-disc");
  });

  it("renders fenced code with language metadata, highlighting and copy action", () => {
    const output = renderToStaticMarkup(
      <MarkdownPreview markdown={"```typescript\nconst total: number = 100\n```"} />,
    );

    expect(output).toContain("TypeScript");
    expect(output).toContain("Copy code");
    expect(output).toContain("hljs-keyword");
    expect(output).toContain("overflow-x-auto");
  });
});
