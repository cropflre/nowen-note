import { describe, expect, it } from "vitest";
import { analyzeTiptapDocument } from "@/lib/tiptapAnalysis";

describe("analyzeTiptapDocument", () => {
  it("derives plain text, statistics and ProseMirror heading positions", () => {
    const result = analyzeTiptapDocument({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "开场 hello" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Second" }] },
      ],
    });

    expect(result.plainText).toBe("开场 hello\nSecond");
    expect(result.headings).toEqual([{ id: "h-0", level: 2, text: "Second", pos: 10 }]);
    expect(result.stats).toEqual({ chars: 15, charsNoSpace: 13, words: 4 });
  });
});
