import assert from "node:assert/strict";
import test from "node:test";

import { siyuanSyToMarkdown, type SiyuanNode } from "../src/lib/siyuanSyParser.js";
import { siyuanSyToTiptapJson } from "../src/lib/siyuanTiptapConverter.js";

const TYPES = ["TIP", "NOTE", "IMPORTANT", "WARNING", "CAUTION"] as const;

function createCalloutDocument(): SiyuanNode {
  return {
    Type: "NodeDocument",
    Properties: { title: "Callout compatibility" },
    Children: TYPES.map((type) => ({
      Type: "NodeCallout",
      CalloutType: type,
      CalloutTitle: type[0] + type.slice(1).toLowerCase(),
      Children: [{
        Type: "NodeParagraph",
        Children: [{ Type: "NodeText", Data: `这是${type}类型Callout` }],
      }],
    })),
  };
}

test("rich text keeps SiYuan Callouts as standard editable blockquotes", () => {
  const parsed = JSON.parse(siyuanSyToTiptapJson(createCalloutDocument())) as {
    type: string;
    content: Array<{
      type: string;
      content?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    }>;
  };

  assert.equal(parsed.type, "doc");
  assert.equal(parsed.content.length, TYPES.length);

  for (const [index, type] of TYPES.entries()) {
    const blockquote = parsed.content[index];
    assert.equal(blockquote.type, "blockquote");
    assert.equal(blockquote.content?.[0]?.type, "paragraph");
    assert.equal(blockquote.content?.[0]?.content?.[0]?.text, `[!${type}] ${type[0] + type.slice(1).toLowerCase()}`);
    assert.equal(blockquote.content?.[1]?.content?.[0]?.text, `这是${type}类型Callout`);
  }
});

test("Markdown import keeps native GFM alert syntax and reports Callout as supported", () => {
  const result = siyuanSyToMarkdown(createCalloutDocument());

  for (const type of TYPES) {
    assert.match(result.markdown, new RegExp(`\\[!${type}\\]`));
  }
  assert.doesNotMatch(result.markdown, /data-callout|nowen-siyuan-callout/);
  assert.equal(result.stats.unsupportedNodes.NodeCallout, undefined);
  assert.equal(result.warnings.some((warning) => /callout/i.test(warning)), false);
});
