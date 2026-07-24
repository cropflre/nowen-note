import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownCodeBlock } from "@/components/MarkdownCodeBlock";

const CODE = `-- transform
fn buildTransform value =
(
  local result = matrix3 1
  format "value: %\\n" value
  result
)`;

describe("MarkdownCodeBlock MAXScript highlighting", () => {
  it.each(["maxscript", "ms", "mcr"])("renders language-%s with a shared label and grammar", (language) => {
    const html = renderToStaticMarkup(
      <MarkdownCodeBlock className={`language-${language}`}>{CODE}</MarkdownCodeBlock>,
    );

    expect(html).toContain("MAXScript");
    expect(html).toContain("hljs-comment");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-title");
    expect(html).toContain("hljs-built_in");
  });
});
