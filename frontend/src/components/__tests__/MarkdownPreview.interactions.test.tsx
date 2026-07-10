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
