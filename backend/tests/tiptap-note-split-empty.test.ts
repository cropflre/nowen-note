import assert from "node:assert/strict";
import test from "node:test";

import {
  planTiptapNoteSplit,
  serializeTiptapSection,
} from "../src/lib/tiptapNoteSplit.ts";

test("serializes a heading-only Tiptap section with a valid empty paragraph", () => {
  const content = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1, blockId: "blk_empty_heading" },
        content: [{ type: "text", text: "Empty" }],
      },
      {
        type: "heading",
        attrs: { level: 1, blockId: "blk_next_heading" },
        content: [{ type: "text", text: "Next" }],
      },
      {
        type: "paragraph",
        attrs: { blockId: "blk_next_body" },
        content: [{ type: "text", text: "Body" }],
      },
    ],
  });
  const plan = planTiptapNoteSplit(content, 1);
  const serialized = JSON.parse(serializeTiptapSection(plan, plan.sections[0]));
  assert.deepEqual(serialized.content, [{ type: "paragraph", content: [] }]);
});
