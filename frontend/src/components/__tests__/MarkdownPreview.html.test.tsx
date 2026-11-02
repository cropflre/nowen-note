import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { MarkdownPreview } from "@/components/MarkdownPreview";

describe("MarkdownPreview imported HTML", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: {
        href: "https://note.example.com/app",
        origin: "https://note.example.com",
      },
      open: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders semantic HTML while removing scripts and event handlers", () => {
    const output = renderToStaticMarkup(
      <MarkdownPreview
        markdown={'<mark onclick="alert(1)">重点</mark><script>alert(2)</script><a href="javascript:alert(3)">bad</a>'}
      />,
    );

    expect(output).toContain("<mark");
    expect(output).toContain("重点");
    expect(output).not.toContain("<script");
    expect(output).not.toContain("onclick");
    expect(output).not.toContain("javascript:");
  });

  it("renders third-party iframes with the fixed cross-origin sandbox", () => {
    const output = renderToStaticMarkup(
      <MarkdownPreview markdown={'<iframe src="https://player.example.com/embed/1" title="demo"></iframe>'} />,
    );

    expect(output).toContain('src="https://player.example.com/embed/1"');
    expect(output).toContain("allow-scripts allow-same-origin allow-forms allow-popups allow-presentation");
    expect(output).toContain("strict-origin-when-cross-origin");
  });

  it("does not grant allow-same-origin to same-origin embeds", () => {
    const output = renderToStaticMarkup(
      <MarkdownPreview markdown={'<iframe src="/api/attachments/file-1" title="local"></iframe>'} />,
    );

    expect(output).toContain('src="https://note.example.com/api/attachments/file-1"');
    expect(output).toContain("allow-scripts allow-forms allow-popups allow-presentation");
    expect(output).not.toContain("allow-scripts allow-same-origin allow-forms");
  });
});
