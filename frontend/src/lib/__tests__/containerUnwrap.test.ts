import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import { ColumnsExtension } from "@/components/extensions/ColumnsExtension";
import { CalloutExtension } from "@/components/extensions/CalloutExtension";
import {
  convertBlock, deleteBlock, cutBlock, addBelowBlock, locateBlock,
} from "@/components/blockMenuActions";

/**
 * 容器（callout/details）边界上的块操作回归测试。
 *
 * 背景（2026-08-21 修复）：
 * 1. locateBlock 兜底只认 start(d) === from-1，而拖拽柄在 callout/details 容器上时
 *    from = before(容器)+1 = 容器 content 起点（start(d) === from），导致 locateBlock
 *    返回 null → 「高亮想转别的转不了」/ 剪切删除没用 / 在下方添加基本不能用。
 *    已补 start(d) === from 情形。
 * 2. details 解包直接取 firstChild（= detailsSummary 标题行）→ detailsContent 正文丢失。
 *    改为展开 detailsContent 全部子块（unwrapContainerNode）。
 * 3. convertBlock unwrapContainer 后继续用过期 state → mismatched transaction。
 *    已改为 unwrap 后重新取 editor.state。
 */

async function createEditor(content: any) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [StarterKit, Details, DetailsSummary, DetailsContent, ColumnsExtension, CalloutExtension],
    content,
  });
  return { editor, el };
}

// 容器 before 位置（首个块为 0）
function containerFrom(editor: Editor, typeName: string): number {
  let pos = -1;
  editor.state.doc.descendants((n, p) => { if (n.type.name === typeName && pos < 0) { pos = p; return false; } return true; });
  return pos + 1; // 柄传的 from = before + 1
}

describe("容器边界块操作（回归）", () => {
  it("callout 上 from=before+1：locateBlock 返回 callout 而非 null", async () => {
    const { editor, el } = await createEditor({
      type: "doc", content: [{ type: "callout", attrs: { type: "blue" }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] }],
    });
    const from = containerFrom(editor, "callout");
    const info = locateBlock(editor, from, { preferColumn: false });
    expect(info).not.toBeNull();
    expect(info!.typeName).toBe("callout");
    editor.destroy(); el.remove();
  });

  it("callout 含内容转回正文：内容保留", async () => {
    const { editor, el } = await createEditor({
      type: "doc", content: [{ type: "callout", attrs: { type: "blue" }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] }],
    });
    const ok = convertBlock(editor, { type: "paragraph" }, containerFrom(editor, "callout"));
    expect(ok).toBe(true);
    const json = JSON.stringify(editor.getJSON());
    expect(json).toContain("A");
    expect(json).not.toContain("callout");
    editor.destroy(); el.remove();
  });

  it("callout 含内容转成标题：内容保留", async () => {
    const { editor, el } = await createEditor({
      type: "doc", content: [{ type: "callout", attrs: { type: "blue" }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] }],
    });
    const ok = convertBlock(editor, { type: "heading", level: 2 }, containerFrom(editor, "callout"));
    expect(ok).toBe(true);
    const json = JSON.stringify(editor.getJSON());
    expect(json).toContain('"type":"heading"');
    expect(json).toContain("A");
    editor.destroy(); el.remove();
  });

  it("details 有正文转回正文：detailsContent 内容不丢（展开全部子块）", async () => {
    const { editor, el } = await createEditor({
      type: "doc", content: [{
        type: "details", content: [
          { type: "detailsSummary", content: [{ type: "text", text: "标题" }] },
          { type: "detailsContent", content: [
            { type: "paragraph", content: [{ type: "text", text: "正文1" }] },
            { type: "paragraph", content: [{ type: "text", text: "正文2" }] },
          ] },
        ],
      }],
    });
    const ok = convertBlock(editor, { type: "paragraph" }, containerFrom(editor, "details"));
    expect(ok).toBe(true);
    const json = JSON.stringify(editor.getJSON());
    expect(json).toContain("正文1");
    expect(json).toContain("正文2");
    // summary 标题行不再是唯一内容（detailsContent 正文必须展开保留）
    expect(json).not.toContain("details");
    editor.destroy(); el.remove();
  });

  it("callout 上 from=before+1：deleteBlock 删除整个容器", async () => {
    const { editor, el } = await createEditor({
      type: "doc", content: [
        { type: "callout", attrs: { type: "blue" }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
        { type: "paragraph", content: [{ type: "text", text: "B" }] },
      ],
    });
    deleteBlock(editor, containerFrom(editor, "callout"));
    const json = JSON.stringify(editor.getJSON());
    expect(json).not.toContain("callout");
    expect(json).toContain("B");
    editor.destroy(); el.remove();
  });

  it("callout 上 from=before+1：addBelowBlock 在容器下方插入空段落", async () => {
    const { editor, el } = await createEditor({
      type: "doc", content: [{ type: "callout", attrs: { type: "blue" }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] }],
    });
    const ret = addBelowBlock(editor, containerFrom(editor, "callout"));
    expect(ret).not.toBeNull();
    // callout + 空段落（TrailingNode 也在末尾补一段）
    expect(editor.getJSON().content.length).toBeGreaterThanOrEqual(2);
    editor.destroy(); el.remove();
  });

  it("callout 上 from=before+1：cutBlock 剪切整个容器", async () => {
    const { editor, el } = await createEditor({
      type: "doc", content: [
        { type: "callout", attrs: { type: "blue" }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
        { type: "paragraph", content: [{ type: "text", text: "B" }] },
      ],
    });
    await cutBlock(editor, containerFrom(editor, "callout"));
    const json = JSON.stringify(editor.getJSON());
    expect(json).not.toContain("callout");
    expect(json).toContain("B");
    editor.destroy(); el.remove();
  });
});
