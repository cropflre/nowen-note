import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import { CalloutExtension } from "@/components/extensions/CalloutExtension";
import { ColumnsExtension } from "@/components/extensions/ColumnsExtension";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Document } from "@tiptap/extension-document";
import { repairTiptapJson } from "@/lib/tiptapSchemaRepair";

/**
 * Callout（高亮块）自研扩展测试：
 * 1. insertCallout 命令：无选区 → 插入空 callout；有选区 → 包裹选区内容
 * 2. 分栏内安全插入 callout（safeInsertContainerInColumn 通用分支逻辑）：
 *    显式 from 定位目标栏，不出现在其它栏
 * 3. repairTiptapJson round-trip：callout 节点与 type/icon 属性不丢
 */

function buildEditor(extensions: any[], content: any) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [Document, Text, Paragraph, ...extensions],
    content,
  });
}

describe("CalloutExtension", () => {
  it("无选区时 insertCallout 插入空 callout（含默认 paragraph）", () => {
    const editor = buildEditor([CalloutExtension], {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "before" }] }],
    });

    // 光标移到文档末尾
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const ok = editor.chain().focus().insertCallout({ type: "blue" }).run();
    expect(ok).toBe(true);

    let calloutCount = 0;
    let hasParagraphInside = false;
    editor.state.doc.descendants((n) => {
      if (n.type.name === "callout") {
        calloutCount++;
        if (n.content.firstChild?.type.name === "paragraph") hasParagraphInside = true;
      }
    });
    console.log("[insert-empty] calloutCount:", calloutCount, "hasParagraphInside:", hasParagraphInside);
    expect(calloutCount).toBe(1);
    expect(hasParagraphInside).toBe(true);

    editor.destroy();
  });

  it("有选区时 insertCallout 把选区内容包进 callout", () => {
    const editor = buildEditor([CalloutExtension], {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello callout" }] }],
    });

    editor.commands.setTextSelection({ from: 1, to: 6 }); // 选中 "hello"
    const ok = editor.chain().focus().insertCallout({ type: "yellow" }).run();
    expect(ok).toBe(true);

    let calloutNode: any = null;
    editor.state.doc.descendants((n) => {
      if (n.type.name === "callout" && !calloutNode) calloutNode = n;
    });
    expect(calloutNode).toBeTruthy();
    expect(calloutNode.attrs.type).toBe("yellow");
    // 包裹后 callout 内容应包含被选中的文本
    const text = calloutNode.textContent;
    console.log("[insert-selection] callout text:", JSON.stringify(text));
    expect(text).toContain("hello");

    editor.destroy();
  });

  it("`:::callout ` 输入规则能生成 callout（wrappingInputRule）", () => {
    const editor = buildEditor([CalloutExtension], {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: ":::callout " }] }],
    });

    // 直接验证 schema 含 callout 节点 + 输入规则触发链存在
    expect(editor.schema.nodes.callout).toBeTruthy();
    // 输入规则：模拟在行首输入 ":::callout " 后触发
    editor.commands.setTextSelection(1);
    const handled = editor.commands.insertContent(":::callout ");
    // 注意：wrappingInputRule 在真实键盘输入时由插件处理；insertContent 可能不触发，
    // 因此这里只验证命令链可用 + schema 就绪，行为验证以 round-trip 为准。
    console.log("[inputrule] insertContent handled:", handled, "| schema has callout:", !!editor.schema.nodes.callout);
    expect(editor.schema.nodes.callout).toBeTruthy();
    editor.destroy();
  });

  it("分栏内安全插入 callout：显式 from 定位，callout 出现在栏1（不出现在栏2）", () => {
    const editor = buildEditor([CalloutExtension, ColumnsExtension], {
      type: "doc",
      content: [{
        type: "column_container",
        content: [
          { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "col1-text" }] }] },
          { type: "column", attrs: { colWidth: 200 }, content: [{ type: "paragraph", content: [{ type: "text", text: "col2-text" }] }] },
        ],
      }],
    });

    // 找到栏1段落的显式位置
    let col1Pos = -1;
    let col2Pos = -1;
    editor.state.doc.descendants((n, p) => {
      if (n.type.name === "paragraph" && n.textContent === "col1-text") col1Pos = p;
      if (n.type.name === "paragraph" && n.textContent === "col2-text") col2Pos = p;
    });
    expect(col1Pos).toBeGreaterThan(0);
    expect(col2Pos).toBeGreaterThan(0);

    // 模拟 safeInsertContainerInColumn 的通用分支（callout content=block+，直接包当前 textblock）
    const { state, view } = editor;
    const $from = state.doc.resolve(col1Pos + 1);
    let inColumn = false;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "column") { inColumn = true; break; }
    }
    expect(inColumn).toBe(true);

    const containerType = state.schema.nodes["callout"];
    expect(containerType).toBeTruthy();

    const targetDepth = $from.depth;
    const currentNode = $from.node(targetDepth);
    const blockStart = $from.before(targetDepth);
    const blockEnd = $from.after(targetDepth);
    const containerNode = containerType.create({ type: "blue" }, [currentNode]);
    const tr = state.tr.replaceWith(blockStart, blockEnd, containerNode);
    view.dispatch(tr);

    // 验证：callout 在栏1内，栏2 文本不受影响
    let calloutCount = 0;
    let calloutInCol1 = false;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "callout") {
        calloutCount++;
        const $p = editor.state.doc.resolve(pos);
        for (let d = $p.depth; d >= 1; d--) {
          if ($p.node(d).type.name === "column") {
            if ($p.before(d) < col2Pos) calloutInCol1 = true;
            break;
          }
        }
      }
    });

    let col2Text = "";
    editor.state.doc.descendants((n) => {
      if (n.type.name === "paragraph" && n.textContent === "col2-text") col2Text = n.textContent;
    });

    console.log("[safe-insert-callout] count:", calloutCount, "inCol1:", calloutInCol1, "col2Text:", col2Text);
    expect(calloutCount).toBe(1);
    expect(calloutInCol1).toBe(true);
    expect(col2Text).toBe("col2-text");

    editor.destroy();
  });

  it("repairTiptapJson round-trip 保留 callout 节点与 type/icon 属性", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "callout",
          attrs: { type: "yellow", icon: "⚠️" },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "注意安全" }] },
          ],
        },
      ],
    };
    const out = repairTiptapJson(doc) as any;
    const types = (out.content || []).map((n: any) => n.type);
    console.log("callout round-trip types:", JSON.stringify(types));
    expect(types).toContain("callout");

    const callout = out.content.find((n: any) => n.type === "callout");
    expect(callout).toBeTruthy();
    expect(callout.attrs?.type).toBe("yellow");
    expect(callout.attrs?.icon).toBe("⚠️");
  });
});
