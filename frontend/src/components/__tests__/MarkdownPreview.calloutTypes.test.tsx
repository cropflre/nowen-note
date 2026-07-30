import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownPreview } from "@/components/MarkdownPreview";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/MathView", () => ({
  MathView: ({ source }: { source: string }) => <span>{source}</span>,
}));

const CALLOUTS = [
  { type: "NOTE", title: "Note", body: "这是Note类型Callout", className: "border-blue-400/70" },
  { type: "TIP", title: "Tip", body: "这是Tip类型Callout", className: "border-emerald-400/70" },
  { type: "IMPORTANT", title: "Important", body: "这是Important类型Callout", className: "border-violet-400/70" },
  { type: "WARNING", title: "Warning", body: "这是Warning类型Callout", className: "border-amber-400/80" },
  { type: "CAUTION", title: "Caution", body: "这是Caution类型Callout", className: "border-red-400/80" },
] as const;

function buildMarkdown(): string {
  return CALLOUTS.map(({ type, title, body }) => [
    `> [!${type}] ${title}`,
    ">",
    `> ${body}`,
  ].join("\n")).join("\n\n");
}

describe("MarkdownPreview SiYuan Callouts", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders NOTE, TIP, IMPORTANT, WARNING and CAUTION as styled Markdown Callouts", async () => {
    const markdown = buildMarkdown();

    await act(async () => {
      root.render(<MarkdownPreview markdown={markdown} />);
    });

    const blockquotes = Array.from(host.querySelectorAll("blockquote"));
    expect(blockquotes).toHaveLength(CALLOUTS.length);

    CALLOUTS.forEach((expected, index) => {
      const blockquote = blockquotes[index];
      expect(blockquote.className).toContain(expected.className);
      expect(blockquote.textContent).toContain(expected.title);
      expect(blockquote.textContent).toContain(expected.body);
      expect(blockquote.textContent).not.toContain(`[!${expected.type}]`);
    });

    expect(markdown).toContain("> [!NOTE] Note");
    expect(markdown).toContain("> [!TIP] Tip");
    expect(markdown).toContain("> [!IMPORTANT] Important");
    expect(markdown).toContain("> [!WARNING] Warning");
    expect(markdown).toContain("> [!CAUTION] Caution");
  });
});
