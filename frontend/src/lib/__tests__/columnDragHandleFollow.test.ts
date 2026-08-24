import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import { ColumnsExtension } from "@/components/extensions/ColumnsExtension";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Document } from "@tiptap/extension-document";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import { defaultRules, normalizeNestedOptions } from "@tiptap/extension-drag-handle";
import type { DragHandleRule, RuleContext } from "@tiptap/extension-drag-handle";

/**
 * 验证 nested 拖拽柄规则集：
 *  1. prioritizeColumn：column 节点胜出，柄随栏移动
 *  2. prioritizeDetails：details 容器优先（与 prioritizeColumn/prioritizeCallout 对称），
 *     内部节点扣 600 → 柄稳定在折叠块左缘，不跳到相邻块、不在 ">" 旁。
 *     分栏内仍由 prioritizeColumn 保证 column 胜出（details 在栏内被 prioritizeColumn 再扣 600）。
 *
 * 用真实的 defaultRules + 文档化评分公式验证。
 */

// 与 TiptapEditor.tsx 中 <DragHandle nested> 的规则保持一致
const columnPriorityRule: DragHandleRule = {
  id: "prioritizeColumn",
  evaluate: ({ node, $pos, depth }: any) => {
    let inColumn = false;
    for (let d = depth; d >= 1; d--) {
      if ($pos.node(d).type.name === "column") { inColumn = true; break; }
    }
    if (!inColumn) return 0;
    return node.type.name === "column" ? 0 : 600;
  },
};

// 折叠块优先规则（与 prioritizeColumn 对称）
// 命中 details 祖先时，details 容器保持满分 1000，内部节点扣 600
// （与 TiptapEditor.tsx 的 prioritizeDetails 规则一致）
const prioritizeDetailsRule: DragHandleRule = {
  id: "prioritizeDetails",
  evaluate: ({ node, $pos, depth }: any) => {
    let inDetails = false;
    for (let d = depth; d >= 1; d--) {
      if ($pos.node(d).type.name === "details") { inDetails = true; break; }
    }
    if (!inDetails) return 0;
    return node.type.name === "details" ? 0 : 600;
  },
};

const OUR_RULES = [columnPriorityRule, prioritizeDetailsRule];

const BASE_SCORE = 1000;
function scoreOf(ourRules: DragHandleRule[], ctx: RuleContext): number {
  let score = BASE_SCORE;
  const allRules = [...defaultRules, ...ourRules];
  for (const r of allRules) {
    score -= r.evaluate(ctx as any);
    if (score <= 0) return -1;
  }
  return score;
}

function pickWinner(editor: Editor, pos: number, ourRules: DragHandleRule[]) {
  const $pos = editor.state.doc.resolve(pos);
  const candidates: { name: string; depth: number; score: number }[] = [];
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d);
    const ctx = { node, pos: $pos.before(d), depth: d, parent: d > 0 ? $pos.node(d - 1) : null, index: 0, isFirst: true, isLast: false, $pos, view: editor.view } as unknown as RuleContext;
    const s = scoreOf(ourRules, ctx);
    if (s > 0) candidates.push({ name: node.type.name, depth: d, score: s });
  }
  candidates.sort((a, b) => b.score !== a.score ? b.score - a.score : b.depth - a.depth);
  return { candidates, winner: candidates[0]?.name };
}

function buildColumnEditor() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [Document, Text, Paragraph, ColumnsExtension],
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "outside" }] },
        {
          type: "column_container",
          content: [
            { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
            { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
          ],
        },
      ],
    },
  });
  return { editor, el };
}

function buildColumnWithDetailsEditor() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [Document, Text, Paragraph, ColumnsExtension, Details, DetailsSummary, DetailsContent],
    content: {
      type: "doc",
      content: [
        {
          type: "column_container",
          content: [
            {
              type: "column", attrs: { colWidth: 200 },
              content: [
                { type: "paragraph", content: [{ type: "text", text: "col1-plain" }] },
                {
                  type: "details", content: [
                    { type: "detailsSummary", content: [{ type: "paragraph", content: [{ type: "text", text: ">" }] }] },
                    { type: "detailsContent", content: [{ type: "paragraph", content: [{ type: "text", text: "hidden" }] }] },
                  ],
                },
              ],
            },
            { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "col2" }] }] },
          ],
        },
      ],
    },
  });
  return { editor, el };
}

describe("nested drag-handle rules", () => {
  it("配置规范化通过", () => {
    const opts = normalizeNestedOptions({ edgeDetection: "none", rules: OUR_RULES });
    expect(opts.enabled).toBe(true);
    expect(opts.rules.map((r) => r.id)).toEqual(["prioritizeColumn", "prioritizeDetails"]);
  });

  it("分栏内普通段落：column 胜出（柄跟随栏）", () => {
    const { editor } = buildColumnEditor();
    let pos = -1;
    editor.state.doc.descendants((n, p) => { if (n.type.name === "paragraph" && n.textContent === "A") pos = p; });
    expect(pos).toBeGreaterThan(0);

    const { winner, candidates } = pickWinner(editor, pos + 1, OUR_RULES);
    console.log("[col-follow]", JSON.stringify(candidates), "→", winner);
    expect(winner).toBe("column");
    editor.destroy();
  });

  it("分栏外顶层段落：不扣分，保持原体验", () => {
    const { editor } = buildColumnEditor();
    const $top = editor.state.doc.resolve(1);
    const ctx = { node: $top.node($top.depth), pos: 0, depth: $top.depth, parent: null, index: 0, isFirst: true, isLast: false, $pos: $top, view: editor.view };
    expect(scoreOf(OUR_RULES, ctx as RuleContext)).toBe(1000);
    editor.destroy();
  });

  it("分栏内的折叠块：prioritizeDetails 让内部节点扣分，column 仍胜出（柄在栏左缘）", () => {
    const { editor } = buildColumnWithDetailsEditor();
    // 光标落在栏1的 details > 内部
    let summaryPos = -1;
    editor.state.doc.descendants((n, p) => { if (n.type.name === "paragraph" && n.textContent === ">") summaryPos = p; });
    expect(summaryPos).toBeGreaterThan(0);

    const { winner, candidates } = pickWinner(editor, summaryPos + 1, OUR_RULES);
    console.log("[col+details]", JSON.stringify(candidates), "→", winner);
    // column 必须胜出（prioritizeColumn 让 column 保持 1000，非 column 扣 600）
    expect(winner).toBe("column");
    // detailsSummary 被排除（不在候选中）；details 和 detailsContent 保留为候选但分数更低
    expect(candidates.find((c) => c.name === "detailsSummary")).toBeUndefined();
    const detailsCand = candidates.find((c) => c.name === "details");
    if (detailsCand) expect(detailsCand.score).toBeLessThan(1000); // 被 prioritizeColumn 扣 600
    editor.destroy();
  });

  it("分栏内折叠块的正文区域：同样 column 胜出", () => {
    const { editor } = buildColumnWithDetailsEditor();
    let bodyPos = -1;
    editor.state.doc.descendants((n, p) => { if (n.type.name === "paragraph" && n.textContent === "hidden") bodyPos = p; });
    expect(bodyPos).toBeGreaterThan(0);

    const { winner } = pickWinner(editor, bodyPos + 1, OUR_RULES);
    console.log("[col+details-body]", "→", winner);
    expect(winner).toBe("column");
    editor.destroy();
  });

  it("独立折叠块（不在分栏内）：details 容器胜出（柄稳定在块左缘，不跳到相邻块）", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const editor = new Editor({
      element: el,
      extensions: [Document, Text, Paragraph, Details, DetailsSummary, DetailsContent],
      content: {
        type: "doc", content: [{
          type: "details", content: [
            { type: "detailsSummary", content: [{ type: "paragraph", content: [{ type: "text", text: "S" }] }] },
            { type: "detailsContent", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
          ],
        }],
      },
    });
    let summaryPos = -1;
    editor.state.doc.descendants((n, p) => { if (n.textContent === "S") summaryPos = p; });

    const { winner, candidates } = pickWinner(editor, summaryPos + 1, OUR_RULES);
    console.log("[standalone-details]", JSON.stringify(candidates), "→", winner);
    // prioritizeDetails 让 details 容器保持 1000，内部段落/detailsSummary 扣 600→400
    // → details 容器胜出，柄稳定在折叠块左缘（不跳到相邻块）
    expect(winner).toBe("details");
    const detailsCand = candidates.find((c) => c.name === "details");
    if (detailsCand) expect(detailsCand.score).toBe(1000);
    // 内部段落和 detailsSummary 是低分候选但不会赢
    const paraCand = candidates.find((c) => c.name === "paragraph");
    if (paraCand && detailsCand) expect(paraCand.score).toBeLessThan(detailsCand.score);
    editor.destroy();
  });
});
