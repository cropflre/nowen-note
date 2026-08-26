import { describe, expect, it } from "vitest";

import {
  classifyClipboardHtml,
  shouldHandleAsMarkdownPaste,
} from "@/lib/pasteRouting";

/**
 * Regression for the user-reported case where the same article sometimes pasted as proper
 * Tiptap headings/lists/tables and sometimes stayed as literal `##`, `-` and pipe-table text.
 *
 * The important assertion is the legacy two-argument call: TiptapEditor currently invokes
 * `shouldHandleAsMarkdownPaste(html, looksLikeMarkdown(text))`. Keeping this test separate makes
 * sure the production route stays fixed even while the richer object API evolves independently.
 */
describe("paste routing user regression", () => {
  it("HTML 只有 div/span 外壳时，飞牛 NAS 风格 Markdown 继续弹出转换提示", () => {
    const html = [
      "<div><span>## 一、需要解决的问题</span></div>",
      "<div><br></div>",
      "<div>- 家里的飞牛 NAS 只有公网 IPv6;</div>",
      "<div>- 你已经通过飞牛系统里的 DDNS，把 AAAA 记录同步到了</div>",
      "<div>- `fn-ipv6.example.xyz`;</div>",
      "<div><br></div>",
      "<div><span>## 二、解决方案</span></div>",
      "<div>- `fn.example.xyz` 继续走腾讯 EO;</div>",
      "<div>- `fn-share.example.xyz` 走阿里云 ESA;</div>",
      "<div><br></div>",
      "<div>### 2.1 这套方案最后长什么样</div>",
      "<div>| 域名 | 作用 | 走哪一层 |</div>",
      "<div>| --- | --- | --- |</div>",
      "<div>| fn-ipv6.example.xyz | DDNS | NAS |</div>",
    ].join("");

    const analysis = classifyClipboardHtml({ html });
    expect(analysis.kind).toBe("text-shell");

    // This is the exact production-compatible call shape used by TiptapEditor today.
    expect(shouldHandleAsMarkdownPaste(html, true)).toBe(true);
  });

  it("同一文章如果剪贴板已经提供真正 heading/list/table，则继续保留 HTML 富文本", () => {
    const html = [
      "<h2>一、需要解决的问题</h2>",
      "<ul><li>家里的飞牛 NAS 只有公网 IPv6</li><li>DDNS 已同步 AAAA</li></ul>",
      "<h2>二、解决方案</h2>",
      "<table><thead><tr><th>域名</th><th>作用</th></tr></thead>",
      "<tbody><tr><td>fn-ipv6.example.xyz</td><td>DDNS</td></tr></tbody></table>",
    ].join("");

    expect(classifyClipboardHtml({ html }).kind).toBe("rich");
    expect(shouldHandleAsMarkdownPaste(html, true)).toBe(false);
  });
});
