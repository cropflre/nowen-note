import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import { ColumnsExtension } from "@/components/extensions/ColumnsExtension";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Document } from "@tiptap/extension-document";
import { Dropcursor } from "@tiptap/extension-dropcursor";
import { Gapcursor } from "@tiptap/extension-gapcursor";
import { TextSelection } from "@tiptap/pm/state";

/**
 * 复现 & 验证修复：column 节点内 toggleCodeBlock 导致兄弟栏消失的 bug。
 */
describe("column + codeBlock interaction (bug repro & fix)", () => {
  async function createEditor(content?: any) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const editor = new Editor({
      element: el,
      extensions: [
        Document, Text, Paragraph,
        CodeBlock.configure({ HTMLAttributes: { class: "code-block" } }),
        ColumnsExtension, Dropcursor, Gapcursor,
      ],
      content,
    });
    return { editor, el };
  }

  /**
   * 安全地在 column 内切换块类型（最终版）。
   *
   * 核心思路：
   *   1. 找到光标所在的最内层 textblock 节点（paragraph/codeBlock/heading 等）
   *   2. 用 $pos.before(d) .. $pos.after(d) 精确覆盖整个节点（含节点本身的位置）
   *   3. tr.replaceWith 直接替换，不触发 lift
   *   4. 特殊处理 codeBlock→paragraph 的内容展开（codeBlock.content 是 [paragraph]）
   */
  function safeSetBlockType(editor: Editor, targetTypeName: string): boolean {
    const { state, view } = editor;
    const $from = state.doc.resolve(state.selection.from);

    // 检查是否在 column 节点内
    let inColumn = false;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "column") { inColumn = true; break; }
    }
    if (!inColumn) return false;

    const targetType = state.schema.nodes[targetTypeName];
    if (!targetType) return false;

    // 找到光标所在或包含光标的 textblock 节点
    // 策略：先检查当前节点，再检查子节点（处理光标在 column 级别的情况）
    let targetDepth = $from.depth;
    let currentNode = $from.node(targetDepth);

    if (!currentNode.isTextblock) {
      // 光标不在 textblock 内（如在 column 上），找 column 下第一个 textblock 子孙
      // 用 $from.pos 向下搜索最近的 textblock
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
    if (targetDepth === 0 && !$from.node(0).isTextblock) return false;

    // currentNode 已在上方声明/赋值
    const blockStart = $from.before(targetDepth); // 整个节点的起始位置（含节点标记）
    const blockEnd = $from.after(targetDepth);     // 整个节点的结束位置

    // 切换方向：当前是目标类型则切回 paragraph，否则切到目标类型
    const newTypeName = currentNode.type.name === targetTypeName ? "paragraph" : targetTypeName;
    const newNodeType = state.schema.nodes[newTypeName];
    if (!newNodeType) return false;

    // 内容处理：codeBlock 的 content 是 [paragraph(...)]，切回 paragraph 时需展开
    let newContent = currentNode.content;
    if (newTypeName === "paragraph" && currentNode.type.name === targetTypeName) {
      if (newContent.childCount === 1 && newContent.firstChild?.type.name === "paragraph") {
        newContent = newContent.firstChild.content;
      }
    }

    const newNode = newNodeType.create({}, newContent);
    const tr = state.tr.replaceWith(blockStart, blockEnd, newNode);
    try {
      tr.setSelection(TextSelection.create(tr.doc, Math.min(blockStart + 1, tr.doc.content.size - 1)));
    } catch { /* selection 在非文本节点可能失败，忽略 */ }
    view.dispatch(tr);
    return true;
  }

  it("BUG复现：原生 toggleCodeBlock 破坏3栏结构", async () => {
    const { editor } = await createEditor({
      type: "doc", content: [{
        type: "column_container", content: [
          { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
          { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
          { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "C" }] }] },
        ],
      }],
    });

    let pos = -1, idx = 0;
    editor.state.doc.descendants((n, p) => { if (n.type.name === "column") { idx++; if (idx === 2) pos = p; } });
    editor.commands.setTextSelection(pos + 1);
    editor.chain().focus().toggleCodeBlock().run();

    const c = (editor.getJSON() as any).content[0];
    console.log("[BUG] 栏数:", c?.content?.length);
    expect(c?.content?.length).not.toBe(3);
    editor.destroy();
  });

  it("修复验证：safeSetBlockType 保持3栏，第2栏变codeBlock", async () => {
    const { editor } = await createEditor({
      type: "doc", content: [{
        type: "column_container", content: [
          { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
          { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
          { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "C" }] }] },
        ],
      }],
    });

    let pos = -1, idx = 0;
    editor.state.doc.descendants((n, p) => { if (n.type.name === "column") { idx++; if (idx === 2) pos = p; } });
    editor.commands.setTextSelection(pos + 1);

    safeSetBlockType(editor, "codeBlock");

    const container = (editor.getJSON() as any).content[0];
    console.log("[FIX] 栏数:", container.content.length);
    console.log("[FIX] 第2栏:", JSON.stringify(container.content[1]));

    expect(container.content.length).toBe(3);
    expect(container.content[1].content.some((n: any) => n.type === "codeBlock")).toBe(true);
    editor.destroy();
  });

  it("来回切换：para→cb→para→cb 不丢栏", async () => {
    const { editor } = await createEditor({
      type: "doc", content: [{
        type: "column_container", content: [
          { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "X" }] }] },
          { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "Y" }] }] },
        ],
      }],
    });

    let c2p = -1, idx = 0;
    editor.state.doc.descendants((n, p) => { if (n.type.name === "column") { idx++; if (idx === 2) c2p = p; } });

    // para → codeBlock
    editor.commands.setTextSelection(c2p + 1);
    safeSetBlockType(editor, "codeBlock");
    expect((editor.getJSON() as any).content[0].content.length).toBe(2);

    // codeBlock → paragraph：需先把光标移到 codeBlock 内部
    let cbPos = -1;
    editor.state.doc.descendants((n, p) => { if (n.type.name === "codeBlock") cbPos = p; });
    editor.commands.setTextSelection(cbPos + 2); // codeBlock 内的 paragraph 里
    safeSetBlockType(editor, "codeBlock"); // toggle back

    let json = editor.getJSON() as any;
    console.log("[TOGGLE-BACK] 栏数:", json.content[0].content.length);
    console.log("[TOGGLE-BACK] 第2栏:", JSON.stringify(json.content[0].content[1]));
    expect(json.content[0].content.length).toBe(2);
    expect(json.content[0].content[1].content[0].type).toBe("paragraph");

    // 再切回 codeBlock
    safeSetBlockType(editor, "codeBlock");
    json = editor.getJSON() as any;
    expect(json.content[0].content.length).toBe(2);
    expect(json.content[0].content[1].content[0].type).toBe("codeBlock");

    editor.destroy();
  });
});
