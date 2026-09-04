import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import { CalloutExtension } from "@/components/extensions/CalloutExtension";
import { ColumnsExtension } from "@/components/extensions/ColumnsExtension";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Document } from "@tiptap/extension-document";
import { defaultRules, normalizeNestedOptions } from "@tiptap/extension-drag-handle";
import type { DragHandleRule, RuleContext } from "@tiptap/extension-drag-handle";

/**
 * 确认用户反馈的"多余的 6 点拖拽柄"来源：
 * 与 TiptapEditor.tsx 中 <DragHandle nested> 完全一致的规则，
 * 复刻 findBestDragTarget 的候选生成 + 评分 + 排序，
 * 看鼠标悬停在高亮块（callout）/分栏（column）内部内容上时，谁胜出。
 */

// 与 TiptapEditor.tsx 一致的规则
const columnPriorityRule: DragHandleRule = {
  id: "prioritizeColumn",
  evaluate: ({ node, $pos, depth }: any) => {
    let inColumn = false;
    for (let d = depth; d >= 1; d--) {
      if ($pos.node(d).type.name === "column") {
        inColumn = true;
        break;
      }
    }
    if (!inColumn) return 0;
    return node.type.name === "column" ? 0 : 600;
  },
};

const calloutPriorityRule: DragHandleRule = {
  id: "prioritizeCallout",
  evaluate: ({ node, $pos, depth }: any) => {
    let inCallout = false;
    for (let d = depth; d >= 1; d--) {
      if ($pos.node(d).type.name === "callout") {
        inCallout = true;
        break;
      }
    }
    if (!inCallout) return 0;
    return node.type.name === "callout" ? 0 : 600;
  },
};

// 折叠块优先规则（与 prioritizeColumn / prioritizeCallout 对称）
// 命中 details 祖先时，details 容器保持满分，内部节点扣 600
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

const OUR_RULES = [columnPriorityRule, calloutPriorityRule, prioritizeDetailsRule];

const BASE_SCORE = 1000;
function scoreOf(ourRules: DragHandleRule[], ctx: RuleContext): number {
  let score = BASE_SCORE;
  let excluded = false;
  for (const r of [...defaultRules, ...ourRules]) {
    score -= r.evaluate(ctx as any);
    if (score <= 0) { excluded = true; break; }
  }
  return excluded ? -1 : score;
}

function pickWinner(editor: Editor, pos: number, ourRules: DragHandleRule[]) {
  const $pos = editor.state.doc.resolve(pos);
  type Cand = { name: string; depth: number; score: number };
  const candidates: Cand[] = [];
  for (let depth = $pos.depth; depth >= 1; depth--) {
    const node = $pos.node(depth);
    const ctx = {
      node, pos: $pos.before(depth), depth,
      parent: depth > 0 ? $pos.node(depth - 1) : null,
      index: 0, isFirst: true, isLast: false, $pos, view: editor.view,
    } as unknown as RuleContext;
    const score = scoreOf(ourRules, ctx);
    if (score > 0) candidates.push({ name: node.type.name, depth, score });
  }
  candidates.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.depth - a.depth));
  return { candidates, winner: candidates[0]?.name ?? null };
}

function buildEditor(extensions: any[], content: any) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return new Editor({ element: el, extensions: [Document, Text, Paragraph, ...extensions], content });
}

describe("确认：高亮块/分栏内部内容的拖拽柄归属", () => {
  it("高亮块（callout）内部段落：prioritizeCallout 让 callout 容器胜出（柄固定在块左缘，不再进内容）", () => {
    const editor = buildEditor([CalloutExtension], {
      type: "doc",
      content: [
        { type: "callout", attrs: { type: "info" }, content: [{ type: "paragraph", content: [{ type: "text", text: "内部内容" }] }] },
      ],
    });
    let innerPos = -1;
    editor.state.doc.descendants((n, p) => {
      if (n.type.name === "paragraph" && n.textContent === "内部内容") innerPos = p;
    });
    expect(innerPos).toBeGreaterThan(0);
    const { candidates, winner } = pickWinner(editor, innerPos + 1, OUR_RULES);
    console.log("[callout-inner 修复后]", JSON.stringify(candidates), "→ winner:", winner);
    // 修复后：prioritizeCallout 让内部 paragraph 扣 600 → score 1000-600=400，
    // callout 容器保持 1000 胜出。paragraph 仍是候选但分数更低（不会当成 winner）。
    // 柄固定在 callout 左缘，不再随鼠标在内容/边缘跳动（图1↔图2）。
    expect(winner).toBe("callout");
    const para = candidates.find((c) => c.name === "paragraph");
    const callout = candidates.find((c) => c.name === "callout");
    if (para && callout) expect(para.score).toBeLessThan(callout.score);
    editor.destroy();
  });

  it("高亮块（callout）容器边缘（非内容段落内部）：callout 胜出（与上面一致 → 柄不再跳）", () => {
    // 模拟鼠标在 callout 容器附近（解析到 callout depth），目标候选只有 callout
    const editor = buildEditor([CalloutExtension], {
      type: "doc",
      content: [
        { type: "callout", attrs: { type: "info" }, content: [{ type: "paragraph", content: [{ type: "text", text: "内部内容" }] }] },
      ],
    });
    // 解析到 callout 容器内部（depth=1，node=callout），相当于鼠标在容器边缘
    let calloutPos = -1;
    editor.state.doc.descendants((n, p) => {
      if (n.type.name === "callout" && calloutPos < 0) calloutPos = p;
    });
    expect(calloutPos).toBeGreaterThanOrEqual(0);
    const { winner } = pickWinner(editor, calloutPos + 1, OUR_RULES);
    expect(winner).toBe("callout");
    editor.destroy();
  });

  it("分栏（column）内部段落：prioritizeColumn 让 column 胜出（柄在栏左缘）", () => {
    const editor = buildEditor([ColumnsExtension], {
      type: "doc",
      content: [{
        type: "column_container",
        content: [
          { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
        ],
      }],
    });
    let innerPos = -1;
    editor.state.doc.descendants((n, p) => {
      if (n.type.name === "paragraph" && n.textContent === "A") innerPos = p;
    });
    expect(innerPos).toBeGreaterThan(0);
    const { candidates, winner } = pickWinner(editor, innerPos + 1, OUR_RULES);
    console.log("[column-inner]", JSON.stringify(candidates), "→ winner:", winner);
    expect(winner).toBe("column");
    editor.destroy();
  });

  it("高亮块在分栏内：column 优先于 callout 内部段落", () => {
    const editor = buildEditor([ColumnsExtension, CalloutExtension], {
      type: "doc",
      content: [{
        type: "column_container",
        content: [
          {
            type: "column", attrs: { colWidth: 200 },
            content: [
              { type: "callout", attrs: { type: "warning" }, content: [{ type: "paragraph", content: [{ type: "text", text: "栏内高亮" }] }] },
            ],
          },
        ],
      }],
    });
    let innerPos = -1;
    editor.state.doc.descendants((n, p) => {
      if (n.type.name === "paragraph" && n.textContent === "栏内高亮") innerPos = p;
    });
    expect(innerPos).toBeGreaterThan(0);
    const { candidates, winner } = pickWinner(editor, innerPos + 1, OUR_RULES);
    console.log("[callout-in-column]", JSON.stringify(candidates), "→ winner:", winner);
    expect(winner).toBe("column");
    editor.destroy();
  });
});
