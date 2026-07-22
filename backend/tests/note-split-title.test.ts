import assert from "node:assert/strict";
import test from "node:test";

import { planMarkdownNoteSplit } from "../src/lib/noteSplit.ts";

test("service planner strips persisted block ids from chapter titles", () => {
  const source = [
    "# Alpha ^blk_12345678",
    "Alpha body",
    "# Beta ^blk_abcdefgh",
    "Beta body",
  ].join("\n");

  const plan = planMarkdownNoteSplit(source, 1);
  assert.deepEqual(plan.sections.map((section) => section.title), ["Alpha", "Beta"]);
});
