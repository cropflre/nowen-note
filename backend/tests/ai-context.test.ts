import assert from "node:assert/strict";
import test from "node:test";
import { fitContextBudget, noteToPlainText } from "../src/services/ai-context";

test("noteToPlainText preserves markdown tables, code, and tail text", () => {
  const text = noteToPlainText({
    contentFormat: "markdown",
    content: [
      "# 开头标题",
      "",
      "| 名称 | 值 |",
      "| --- | --- |",
      "| alpha | beta |",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "这是正文尾部唯一标记：TAIL-218",
    ].join("\n"),
    contentText: "过期的短预览",
  });

  assert.match(text, /开头标题/);
  assert.match(text, /alpha/);
  assert.match(text, /const answer = 42/);
  assert.match(text, /TAIL-218/);
});

test("noteToPlainText walks rich-text JSON instead of trusting a short preview", () => {
  const text = noteToPlainText({
    contentFormat: "tiptap-json",
    content: JSON.stringify({
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "富文本标题" }] },
        { type: "paragraph", content: [{ type: "text", text: "中部信息 MID-218" }] },
        {
          type: "table",
          content: [{
            type: "tableRow",
            content: [
              { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "单元格 A" }] }] },
              { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "单元格 B" }] }] },
            ],
          }],
        },
      ],
    }),
    contentText: "短预览",
  });

  assert.match(text, /富文本标题/);
  assert.match(text, /MID-218/);
  assert.match(text, /单元格 A/);
  assert.match(text, /单元格 B/);
});

test("fitContextBudget explicitly retains head, middle, and tail", () => {
  const source = `${"H".repeat(8_000)}MID-218${"M".repeat(8_000)}TAIL-218`;
  const result = fitContextBudget(source, 6_000);

  assert.equal(result.truncated, true);
  assert.equal(result.strategy, "head-middle-tail");
  assert.ok(result.omittedChars > 0);
  assert.match(result.text, /正文开头/);
  assert.match(result.text, /MID-218/);
  assert.match(result.text, /正文结尾/);
  assert.match(result.text, /TAIL-218/);
  assert.deepEqual(result.segments.map((segment) => segment.label), ["head", "middle", "tail"]);
});

test("fitContextBudget reports complete reads without false truncation", () => {
  const source = "small complete note";
  const result = fitContextBudget(source, 10_000);
  assert.equal(result.text, source);
  assert.equal(result.truncated, false);
  assert.equal(result.omittedChars, 0);
  assert.equal(result.strategy, "full");
});
