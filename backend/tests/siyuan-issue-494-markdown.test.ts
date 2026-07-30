import assert from "node:assert/strict";
import test from "node:test";

import { siyuanSyToMarkdown, type SiyuanNode } from "../src/lib/siyuanSyParser.js";

test("issue 494 decodes iframe parameters once and removes heading IAL suffixes", () => {
  const document: SiyuanNode = {
    Type: "NodeDocument",
    Properties: { title: "Issue 494" },
    Children: [
      {
        Type: "NodeHeading",
        HeadingLevel: 2,
        Children: [
          {
            Type: "NodeText",
            Data: "分享链接 {: id=\"20260727010101-abcdefg\"}",
          },
        ],
      },
      {
        Type: "NodeIFrame",
        Data: "<iframe src=\"https://pan.example.test/#/share?sid=kkrjkp7p&amp;amp;p=XfN7xr\"></iframe>",
      },
    ],
  };

  const result = siyuanSyToMarkdown(document);

  assert.match(result.markdown, /^## 分享链接$/m);
  assert.doesNotMatch(result.markdown, /\{:\s*id=/);
  assert.match(result.markdown, /src="https:\/\/pan\.example\.test\/#\/share\?sid=kkrjkp7p&amp;p=XfN7xr"/);
  assert.doesNotMatch(result.markdown, /&amp;amp;/);
});

test("issue 494 heading cleanup does not rewrite fenced code", () => {
  const document: SiyuanNode = {
    Type: "NodeDocument",
    Properties: { title: "Fence" },
    Children: [
      {
        Type: "NodeCodeBlock",
        CodeBlockInfo: "markdown",
        Data: "# 示例 {: id=\"keep-inside-code\"}",
      },
    ],
  };

  const result = siyuanSyToMarkdown(document);
  assert.match(result.markdown, /# 示例 \{: id="keep-inside-code"\}/);
});
