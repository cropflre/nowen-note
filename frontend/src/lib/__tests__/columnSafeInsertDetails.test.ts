import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import { ColumnsExtension } from "@/components/extensions/ColumnsExtension";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Document } from "@tiptap/extension-document";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";

/**
 * 验证"在栏1插入折叠块不会跑到栏2"的安全路径。
 *
 * 问题：setDetails() 内部用 state.selection 确定位置，在分栏嵌套结构中
 * selection 可能漂移（尤其是拖拽柄打开斜杠菜单时 dragHandlePosRef 已更新到别的栏）。
 *
 * 解决：safeInsertContainerInColumn 用显式传入的 from 位置解析目标栏，
 * 直接 tr.replaceWith 在该位置插入 details 容器节点。
 */

function buildTwoColumnEditor() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [Document, Text, Paragraph, ColumnsExtension, Details, DetailsSummary, DetailsContent],
    content: {
      type: "doc",
      content: [{
        type: "column_container",
        content: [
          { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "col1-text" }] }] },
          { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "col2-text" }] }] },
        ],
      }],
    },
  });
  return { editor, el };
}

/**
 * 复制 SlashCommands.tsx 中 safeInsertContainerInColumn 的核心逻辑用于测试
 */
function safeInsertDetails(editor: Editor, explicitFrom: number): boolean {
  const { state, view } = editor;
  const $from = state.doc.resolve(explicitFrom);

  // 向上查找 column
  let inColumn = false;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "column") { inColumn = true; break; }
  }
  if (!inColumn) return false;

  const containerType = state.schema.nodes["details"];
  const summaryType = state.schema.nodes["detailsSummary"];
  const contentType = state.schema.nodes["detailsContent"];
  if (!containerType || !summaryType || !contentType) return false;

  // 找 textblock
  let targetDepth = $from.depth;
  let currentNode = $from.node(targetDepth);
  if (!currentNode.isTextblock) {
    let found = false;
    const maxPos = Math.min($from.after(targetDepth), state.doc.content.size);
    for (let p = $from.start(targetDepth); p < maxPos; p++) {
      const resolved = state.doc.resolve(p);
      if (resolved.parent.isTextblock && resolved.parent !== currentNode) {
        targetDepth = resolved.depth;
        currentNode = resolved.parent;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }

  const blockStart = $from.before(targetDepth);
  const blockEnd = $from.after(targetDepth);

  const containerNode = containerType.create({}, [
    summaryType.create(),
    contentType.create(currentNode.content.childCount > 0 ? [currentNode.content.toJSON()] : []),
  ]);

  const tr = state.tr.replaceWith(blockStart, blockEnd, containerNode);
  try {
    tr.setSelection(require("@tiptap/pm/state").TextSelection.create(tr.doc, Math.min(blockStart + 2, tr.doc.content.size - 1)));
  } catch { /* ignore */ }
  view.dispatch(tr);
  return true;
}

describe("safe insert details in column", () => {
  it("在栏1的位置插入 details，details 出现在栏1（不出现在栏2）", () => {
    const { editor } = buildTwoColumnEditor();

    // 找到栏1段落的位置
    let col1Pos = -1;
    let col2Pos = -1;
    editor.state.doc.descendants((n, p) => {
      if (n.type.name === "paragraph" && n.textContent === "col1-text") col1Pos = p;
      if (n.type.name === "paragraph" && n.textContent === "col2-text") col2Pos = p;
    });
    expect(col1Pos).toBeGreaterThan(0);
    expect(col2Pos).toBeGreaterThan(0);

    // 用栏1的显式位置执行安全插入
    const result = safeInsertDetails(editor, col1Pos + 1);
    expect(result).toBe(true);

    // 验证：doc 应该有且仅有 1 个 details 节点，且它在栏1内
    let detailsCount = 0;
    let detailsInCol1 = false;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "details") {
        detailsCount++;
        // 检查此 details 是否在第一个 column 内
        const $p = editor.state.doc.resolve(pos);
        for (let d = $p.depth; d >= 1; d--) {
          if ($p.node(d).type.name === "column") {
            // 第一个 column 的起始位置应小于第二个 column
            const start = $p.before(d);
            if (start < col2Pos) detailsInCol1 = true;
            break;
          }
        }
      }
    });

    console.log("[insert-details] detailsCount:", detailsCount, "inCol1:", detailsInCol1);
    expect(detailsCount).toBe(1);           // 只插了 1 个 details
    expect(detailsInCol1).toBe(true);       // 在栏1里

    // 栏2的内容应该保持不变（仍是 "col2-text"）
    let col2Text = "";
    editor.state.doc.descendants((n) => {
      if (n.type.name === "paragraph" && n.textContent === "col2-text") col2Text = n.textContent;
    });
    expect(col2Text).toBe("col2-text");

    editor.destroy();
  });

  it("不在 column 内时返回 false（不干预）", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const editor = new Editor({
      element: el,
      extensions: [Document, Text, Paragraph, Details, DetailsSummary, DetailsContent],
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
    });
    const pos = 1; // 顶层 paragraph 内部
    const result = safeInsertDetails(editor, pos);
    expect(result).toBe(false); // 不在 column 中 → 不处理
    editor.destroy();
  });
});
