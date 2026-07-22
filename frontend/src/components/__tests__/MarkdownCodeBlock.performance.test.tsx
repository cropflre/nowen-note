import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownCodeBlock } from "@/components/MarkdownCodeBlock";
import type { PhaseAPerfEvent } from "@/lib/phaseAPerfDiagnostics";

describe("MarkdownCodeBlock plaintext highlighting", () => {
  it("renders language=text without auto detection", () => {
    const events: PhaseAPerfEvent[] = [];
    globalThis.__NOWEN_PHASE_A_PERF_SINK__ = (event) => events.push(event);
    try {
      const html = renderToStaticMarkup(
        <MarkdownCodeBlock className="language-text">const literal = true;</MarkdownCodeBlock>,
      );
      expect(html).toContain("const literal = true;");
      expect(events.filter((event) => event.type === "lowlight-highlight")).toHaveLength(0);
    } finally {
      globalThis.__NOWEN_PHASE_A_PERF_SINK__ = undefined;
    }
  });
});
